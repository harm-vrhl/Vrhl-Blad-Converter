import { sanityReady } from '@/lib/env';
import { SanityError, uploadImage } from '@/lib/sanity/client';
import { readRun } from '@/lib/server/run';
import { STUDIO } from '@/lib/studio';
import { errorMessage } from '@/lib/util';

export const runtime = 'nodejs';

interface Input {
  /** De bestandsnaam zoals Sanity hem onthoudt, `img-1-01.jpeg`. */
  naam: string;
  mimeType?: string;
}

/**
 * Eén beeld naar Sanity. Eén per verzoek, zodat een artikel met zes grote foto's
 * nooit tegen de 4,5 MB van een verzoek aan loopt. Het token blijft hier.
 */
export async function POST(request: Request) {
  if (!sanityReady()) {
    return Response.json({ error: `${STUDIO} is niet gekoppeld op de server` }, { status: 409 });
  }
  try {
    const run = await readRun<Input>(request);
    const bron = await run.file('bron');
    if (!bron) return Response.json({ error: 'er zat geen beeld in het verzoek' }, { status: 400 });
    const naam = String(run.input.naam ?? 'beeld').replace(/[^\w.-]/g, '_');
    const result = await uploadImage(new Uint8Array(bron.data), naam, run.input.mimeType ?? (bron.type || 'image/jpeg'));
    return Response.json({ _id: result._id });
  } catch (err) {
    const status = err instanceof SanityError && err.status >= 400 ? err.status : 500;
    return Response.json(
      { error: errorMessage(err), detail: err instanceof SanityError ? err.detail : undefined },
      { status }
    );
  }
}
