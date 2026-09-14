import { NextResponse } from 'next/server';
import { writeArtifact } from '@/lib/store';
import { loadMagazine, saveMagazine } from '@/lib/magazine/store';
import { pad2 } from '@/lib/util';

export const runtime = 'nodejs';

/** A dense page's text layer runs to some thousands of characters; more is not text. */
const TEXT_LIMIT = 40_000;

/**
 * One page of a magazine: a picture small enough to send a hundred of, and the
 * text layer. No tiles, no ripped bitmaps, no typography: finding where the
 * articles are needs none of that, and the article run does all of it again on
 * the pages it gets.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const form = await request.formData();
  const pdf = Number(form.get('page'));
  const width = Number(form.get('width'));
  const height = Number(form.get('height'));
  const image = form.get('image');
  const thumb = form.get('thumb');

  if (!Number.isInteger(pdf) || pdf < 1 || !(image instanceof File) || !(thumb instanceof File)) {
    return NextResponse.json({ error: 'ongeldige pagina-upload' }, { status: 400 });
  }

  const magazine = await loadMagazine(id);
  const imageName = await writeArtifact(id, `page-${pad2(pdf)}.jpeg`, Buffer.from(await image.arrayBuffer()));
  const thumbName = await writeArtifact(id, `thumb-${pad2(pdf)}.jpeg`, Buffer.from(await thumb.arrayBuffer()));
  const text = String(form.get('text') ?? '').slice(0, TEXT_LIMIT);
  const label = String(form.get('label') ?? '').trim().slice(0, 40) || null;

  magazine.pages = [
    ...magazine.pages.filter((p) => p.pdf !== pdf),
    { pdf, width, height, image: imageName, thumb: thumbName, text, label }
  ].sort((a, b) => a.pdf - b.pdf);
  magazine.status = magazine.pages.length >= magazine.pageCount ? 'ready' : 'uploading';
  await saveMagazine(magazine);

  return NextResponse.json({ page: pdf, status: magazine.status, uploaded: magazine.pages.length });
}
