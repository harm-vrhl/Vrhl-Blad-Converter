import { packageFiles, slug, toPackage } from '@/lib/canonical';
import { loadJob, readArtifact } from '@/lib/store';
import { zip, type ZipEntry } from '@/lib/zip';
import type { ArticleDocument, Job, PageResult } from '@/lib/types';

export const runtime = 'nodejs';

/**
 * Het artikel als Vrhl Content Package 1.0.
 *
 *   GET  .../package             het pakket plus zijn beeld, als ZIP
 *   GET  .../package?format=json alleen pakket.json
 *   POST .../package             idem, maar met het artikel uit de body
 *
 * De ZIP is wat je aan een importer geeft: het formaat verwijst naar beeld via
 * asset-id's en verwacht de bestanden ernaast, dus los JSON is maar de helft.
 * Met de ZIP uitgepakt slaagt `node canonical/validate.mjs pakket.json
 * --bestanden`, en dat is precies de controle die de andere kant ook doet.
 *
 * POST bestaat omdat het artikel te bewerken is. Wie een woord heeft rechtgezet
 * verwacht dat terug in het pakket, en de server kent alleen wat de run heeft
 * opgeslagen. Dus stuurt de interface mee wat er op dat moment op het scherm
 * staat; zonder body blijft het bij wat er is bewaard.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return build(id, new URL(request.url).searchParams.get('format') === 'json', null);
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let document: ArticleDocument | null = null;
  try {
    const body = (await request.json()) as { document?: ArticleDocument };
    document = body.document ?? null;
  } catch {
    document = null;
  }
  return build(id, new URL(request.url).searchParams.get('format') === 'json', document);
}

async function build(id: string, asJson: boolean, given: ArticleDocument | null): Promise<Response> {
  let job: Job;
  try {
    job = await loadJob(id);
  } catch {
    return new Response('job niet gevonden', { status: 404 });
  }

  const document = given ?? job.document;
  if (!document) {
    return new Response('dit artikel is nog niet geconverteerd', { status: 409 });
  }

  // De woorddekking per pagina staat niet op het document maar naast de job, en
  // dat is waar `bron.betrouwbaarheid` vandaan komt. Een job van voor die stap
  // levert gewoon een pakket zonder betrouwbaarheid op.
  let pages: PageResult[] = [];
  try {
    const raw = await readArtifact(id, 'pages.json');
    pages = JSON.parse(raw.toString('utf8')) as PageResult[];
  } catch {
    pages = [];
  }

  // Een job van voor het rippen van beeld heeft helemaal geen `images`, ook al
  // zegt het type van wel. Dan levert hij een pakket zonder assets op.
  const images = job.images ?? [];
  const pakket = toPackage(document, { images, pages, filename: job.filename });
  const naam = slug(job.filename.replace(/\.pdf$/i, '')) || 'pakket';

  if (asJson) {
    return new Response(JSON.stringify(pakket, null, 2), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${naam}.json"`
      }
    });
  }

  const entries: ZipEntry[] = [
    { path: 'pakket.json', data: new TextEncoder().encode(`${JSON.stringify(pakket, null, 2)}\n`) }
  ];
  for (const file of packageFiles(pakket, images)) {
    try {
      entries.push({ path: file.path, data: new Uint8Array(await readArtifact(id, file.source)) });
    } catch {
      // Een bitmap die niet meer op schijf staat houdt de rest niet tegen; het
      // pakket verwijst er dan naar zonder hem mee te leveren, en dat meldt de
      // validator van de andere kant met zoveel woorden.
    }
  }

  return new Response(new Uint8Array(zip(entries)), {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${naam}.zip"`
    }
  });
}
