import { env } from '../env';

/**
 * De HTTP-kant van Sanity, en verder niets.
 *
 * Fetch in plaats van de SDK, net als bij de taalmodellen: drie endpoints zijn
 * niet genoeg om een dependency voor binnen te halen, en zo blijft zichtbaar wat
 * er precies over de lijn gaat.
 *
 * Dit bestand kent geen enkel documenttype. Wat er geschreven wordt staat in
 * `documents.ts`; hier staat alleen hoe het verstuurd wordt.
 */

const base = (): string => `https://${env.sanityProjectId}.api.sanity.io/v${env.sanityApiVersion}`;

export class SanityError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string
  ) {
    super(message);
    this.name = 'SanityError';
  }
}

function assertConfigured(): void {
  const missing: string[] = [];
  if (!env.sanityProjectId) missing.push('NEXT_PUBLIC_SANITY_PROJECT_ID');
  if (!env.sanityDataset) missing.push('NEXT_PUBLIC_SANITY_DATASET');
  if (!env.sanityToken) missing.push('SANITY_API_TOKEN');
  if (missing.length) {
    throw new SanityError(`Sanity is niet ingesteld; vul ${missing.join(', ')} in .env.local`, 0);
  }
}

async function read(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 600);
  } catch {
    return '';
  }
}

/**
 * Een GROQ-query. Parameters gaan als `$naam` mee in de querystring, JSON
 * gecodeerd, zodat er niets in de query zelf hoeft te worden geplakt.
 */
export async function query<T>(groq: string, params: Record<string, unknown> = {}): Promise<T> {
  assertConfigured();
  const url = new URL(`${base()}/data/query/${env.sanityDataset}`);
  url.searchParams.set('query', groq);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(`$${key}`, JSON.stringify(value));
  }

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${env.sanityToken}` },
    cache: 'no-store'
  });
  if (!response.ok) {
    throw new SanityError(`Sanity gaf ${response.status} op een query`, response.status, await read(response));
  }
  const body = (await response.json()) as { result: T };
  return body.result;
}

export type Mutation =
  | { createOrReplace: Record<string, unknown> }
  | { createIfNotExists: Record<string, unknown> }
  | { patch: { id: string; set?: Record<string, unknown> } };

/**
 * Mutaties in een keer. Sanity voert ze als transactie uit: of ze slagen
 * allemaal, of er verandert niets. Dat is precies wat je wilt bij een import,
 * want een half geschreven artikel is erger dan geen artikel.
 */
export async function mutate(mutations: Mutation[]): Promise<{ results: Array<{ id: string; operation: string }> }> {
  assertConfigured();
  if (!mutations.length) return { results: [] };

  const response = await fetch(`${base()}/data/mutate/${env.sanityDataset}?returnIds=true`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.sanityToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ mutations })
  });
  if (!response.ok) {
    throw new SanityError(`Sanity gaf ${response.status} op een mutatie`, response.status, await read(response));
  }
  return (await response.json()) as { results: Array<{ id: string; operation: string }> };
}

export interface UploadedAsset {
  _id: string;
  url?: string;
}

/**
 * Een afbeelding uploaden. Sanity dedupliceert zelf op de inhoud, dus twee keer
 * hetzelfde bestand sturen levert hetzelfde asset-id op en kost geen dubbele
 * opslag. Daarom hoeft deze kant geen eigen hash bij te houden.
 */
export async function uploadImage(
  data: Uint8Array,
  filename: string,
  contentType: string
): Promise<UploadedAsset> {
  assertConfigured();
  const url = new URL(`${base()}/assets/images/${env.sanityDataset}`);
  url.searchParams.set('filename', filename);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.sanityToken}`,
      'content-type': contentType
    },
    body: data as unknown as BodyInit
  });
  if (!response.ok) {
    throw new SanityError(
      `Sanity gaf ${response.status} op het uploaden van ${filename}`,
      response.status,
      await read(response)
    );
  }
  const body = (await response.json()) as { document: UploadedAsset };
  return body.document;
}
