import type { Pakket } from '@/lib/canonical';
import { sanityReady } from '@/lib/env';
import { SanityError } from '@/lib/sanity/client';
import { pushPackage } from '@/lib/sanity/push';
import { readRun } from '@/lib/server/run';
import type { ExtractedImage } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

interface Input {
  pakket: Pakket;
  /** Per asset-id het `_id` dat Sanity bij het uploaden teruggaf. */
  assets?: Record<string, string>;
  /** Alleen breedte en hoogte, voor een droogloop zonder upload. */
  images?: ExtractedImage[];
  dryRun?: boolean;
  /** Alleen de documenten terug, zodat de uitvoer zo door de validator kan. */
  bare?: boolean;
}

/**
 * Het pakket naar Sanity, nadat de browser het beeld al één voor één heeft
 * geupload. Credits en tags worden opgezocht of aangemaakt, en het artikel gaat
 * als concept weg (`drafts.*`): een import kan nooit meteen live staan.
 *
 * Met `dryRun` raakt dit Sanity niet aan en rekent het alleen uit wat er
 * geschreven zou worden; te controleren met
 * `node canonical/sanity/validate.mjs documenten.json`.
 */
export async function POST(request: Request) {
  try {
    const run = await readRun<Input>(request);
    const { pakket, assets = {}, images = [], dryRun = false, bare = false } = run.input;
    if (!pakket?.artikelen) return Response.json({ error: 'er zat geen pakket in het verzoek' }, { status: 400 });
    if (!dryRun && !sanityReady()) {
      return Response.json(
        { error: 'Sanity is niet ingesteld; vul NEXT_PUBLIC_SANITY_PROJECT_ID, NEXT_PUBLIC_SANITY_DATASET en SANITY_API_TOKEN in' },
        { status: 409 }
      );
    }
    const result = await pushPackage(pakket, { images, assetIds: assets, dryRun });
    return Response.json(bare ? result.documents : result);
  } catch (err) {
    const status = err instanceof SanityError && err.status >= 400 ? err.status : 500;
    return Response.json(
      { error: err instanceof Error ? err.message : String(err), detail: err instanceof SanityError ? err.detail : undefined },
      { status }
    );
  }
}
