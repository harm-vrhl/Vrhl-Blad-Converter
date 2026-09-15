import { toPackage } from '@/lib/canonical';
import { sanityReady } from '@/lib/env';
import { SanityError } from '@/lib/sanity/client';
import { pushPackage } from '@/lib/sanity/push';
import { loadJob, readArtifact } from '@/lib/store';
import type { ArticleDocument, Job, PageResult } from '@/lib/types';

export const runtime = 'nodejs';

/**
 * Het artikel naar Sanity duwen.
 *
 *   POST .../sanity            schrijft het pakket als concept naar Sanity
 *   POST .../sanity?dryRun=1   rekent alleen uit wat er geschreven zou worden
 *
 * De droogloop raakt Sanity niet aan en heeft er ook geen token voor nodig. Wat
 * eruit komt is te controleren met de validator van de opslagvorm zelf:
 *
 *   node canonical/sanity/validate.mjs documenten.json
 *
 * Alles gaat als concept weg (`drafts.*`), want deze converter zet
 * `publicatie.klaar` nooit op true. Een import kan dus niet meteen live staan.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const search = new URL(request.url).searchParams;
  const dryRun = search.get('dryRun') === '1';
  // `bare` geeft alleen de documenten terug, zodat de uitvoer rechtstreeks door
  // canonical/sanity/validate.mjs kan zonder er eerst iets uit te peuteren.
  const bare = search.get('bare') === '1';

  if (!dryRun && !sanityReady()) {
    return Response.json(
      { error: 'Sanity is niet ingesteld; vul NEXT_PUBLIC_SANITY_PROJECT_ID, NEXT_PUBLIC_SANITY_DATASET en SANITY_API_TOKEN in .env.local' },
      { status: 409 }
    );
  }

  let job: Job;
  try {
    job = await loadJob(id);
  } catch {
    return Response.json({ error: 'job niet gevonden' }, { status: 404 });
  }

  // Net als bij de pakket-route: wat op het scherm staat wint van wat er is
  // opgeslagen, zodat een correctie uit de Artikel-tab ook echt meegaat naar het CMS.
  let given: ArticleDocument | null = null;
  try {
    const body = (await request.json()) as { document?: ArticleDocument };
    given = body.document ?? null;
  } catch {
    given = null;
  }

  const document = given ?? job.document;
  if (!document) return Response.json({ error: 'dit artikel is nog niet geconverteerd' }, { status: 409 });

  let pages: PageResult[] = [];
  try {
    pages = JSON.parse((await readArtifact(id, 'pages.json')).toString('utf8')) as PageResult[];
  } catch {
    pages = [];
  }

  const images = job.images ?? [];
  const pakket = toPackage(document, { images, pages, filename: job.filename });

  try {
    const result = await pushPackage(pakket, {
      images,
      readFile: async (name) => new Uint8Array(await readArtifact(id, name)),
      dryRun
    });
    return Response.json(bare ? result.documents : result);
  } catch (err) {
    const status = err instanceof SanityError && err.status >= 400 ? err.status : 500;
    return Response.json(
      {
        error: err instanceof Error ? err.message : String(err),
        detail: err instanceof SanityError ? err.detail : undefined
      },
      { status }
    );
  }
}
