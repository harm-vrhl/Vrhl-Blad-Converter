import { NextResponse } from 'next/server';
import { loadJob, saveJob, writeArtifact } from '@/lib/store';
import { pad2 } from '@/lib/util';
import type { ExtractedImage } from '@/lib/types';

export const runtime = 'nodejs';

interface RippedMeta {
  width: number;
  height: number;
  placed: { x: number; y: number; w: number; h: number };
  areaPct: number;
  dpi: number;
  mime: string;
}

/**
 * One rendered page at a time: the browser rasterises the page and rips the
 * bitmaps embedded in it, the server only stores what arrives.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const form = await request.formData();
  const page = Number(form.get('page'));
  const width = Number(form.get('width'));
  const height = Number(form.get('height'));
  const image = form.get('image');
  const thumb = form.get('thumb');

  if (!Number.isInteger(page) || page < 1 || !(image instanceof File) || !(thumb instanceof File)) {
    return NextResponse.json({ error: 'ongeldige pagina-upload' }, { status: 400 });
  }

  const job = await loadJob(id);
  const imageName = await writeArtifact(id, `page-${pad2(page)}.jpeg`, Buffer.from(await image.arrayBuffer()));
  const thumbName = await writeArtifact(id, `thumb-${pad2(page)}.jpeg`, Buffer.from(await thumb.arrayBuffer()));

  const meta = JSON.parse(String(form.get('ripped') ?? '[]')) as RippedMeta[];
  const ripped: ExtractedImage[] = [];
  for (let i = 0; i < meta.length; i++) {
    const full = form.get(`rip${i}`);
    const preview = form.get(`ripThumb${i}`);
    if (!(full instanceof File) || !(preview instanceof File)) continue;

    const extension = meta[i].mime === 'image/png' ? 'png' : 'jpeg';
    const name = `img-p${pad2(page)}-${pad2(i + 1)}`;
    ripped.push({
      id: `img-${page}-${pad2(i + 1)}`,
      page,
      file: await writeArtifact(id, `${name}.${extension}`, Buffer.from(await full.arrayBuffer())),
      thumb: await writeArtifact(id, `${name}-thumb.${extension}`, Buffer.from(await preview.arrayBuffer())),
      width: meta[i].width,
      height: meta[i].height,
      placed: meta[i].placed,
      areaPct: meta[i].areaPct,
      dpi: meta[i].dpi
    });
  }

  job.pages = [...job.pages.filter((p) => p.page !== page), { page, width, height, image: imageName, thumb: thumbName }].sort(
    (a, b) => a.page - b.page
  );
  job.images = [...job.images.filter((img) => img.page !== page), ...ripped].sort(
    (a, b) => a.page - b.page || a.id.localeCompare(b.id)
  );
  job.status = job.pages.length >= job.pageCount ? 'ready' : 'uploading';
  await saveJob(job);

  return NextResponse.json({ page, status: job.status, uploaded: job.pages.length, images: ripped.length });
}
