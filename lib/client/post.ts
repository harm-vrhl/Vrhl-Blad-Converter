'use client';

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

export function runForm(input: object, files: Record<string, Blob> = {}, what = 'dit verzoek'): FormData {
  const json = JSON.stringify(input);
  const size = new Blob([json]).size + Object.values(files).reduce((n, blob) => n + blob.size, 0);
  if (size > BODY_LIMIT) {
    throw new TooLarge(
      `${what} is ${(size / 1024 / 1024).toFixed(1).replace('.', ',')} MB, en de server neemt maximaal 4,5 MB per keer aan.`
    );
  }
  const form = new FormData();
  form.set('input', json);
  for (const [name, blob] of Object.entries(files)) form.set(`file:${name}`, blob, name);
  return form;
}

async function failure(res: Response): Promise<Error> {
  if (res.status === 401) return new Error('Je bent niet (meer) ingelogd. Herlaad de pagina en log opnieuw in.');
  if (res.status === 413) return new TooLarge('Het verzoek was te groot voor de server (meer dan 4,5 MB).');
  if (res.status === 504) return new Error('De server deed er te lang over en is gestopt. Probeer het nog eens.');
  const text = await res.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { error?: string; detail?: unknown };
    if (body.error) {
      const detail = typeof body.detail === 'string' ? body.detail : body.detail ? JSON.stringify(body.detail) : '';
      return new Error(detail ? `${body.error} (${detail.slice(0, 300)})` : body.error);
    }
  } catch {
    /* geen JSON */
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
 */
export async function postStream<E extends { type: string }>(
  url: string,
  body: FormData,
  onEvent: (event: E) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(url, { method: 'POST', body, signal });
  if (!res.ok) throw await failure(res);
  if (!res.body) throw new Error('geen stream ontvangen');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const line = chunk.replace(/^data: ?/, '').trim();
      if (!line) continue;
      const event = JSON.parse(line) as E & { message?: string };
      if (event.type === 'error') throw new Error(event.message ?? 'de server meldde een fout');
      onEvent(event);
    }
  }
}
