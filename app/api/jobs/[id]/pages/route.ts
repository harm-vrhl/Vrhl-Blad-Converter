import { NextResponse } from 'next/server';
import { loadJob, saveJob, writeArtifact } from '@/lib/store';
import { pad2 } from '@/lib/util';
import type { ExtractedImage, InlineStyle, TypographySource } from '@/lib/types';
import type { FragmentKind, StyleFragment } from '@/lib/agents/styling';

export const runtime = 'nodejs';

interface RippedMeta {
  width: number;
  height: number;
  placed: { x: number; y: number; w: number; h: number };
  areaPct: number;
  dpi: number;
  mime: string;
  parts?: number;
  partOf?: number | 'tekst';
}

const STYLES: InlineStyle[] = ['bold', 'italic', 'underline'];
const KINDS: FragmentKind[] = ['text', 'title', 'streamer'];
const SOURCES: TypographySource[] = ['read', 'no-text-layer', 'unnamed-fonts'];

/**
 * What the browser read off the PDF's font table, held to its shape. It arrives
 * over the wire like everything else, so nothing is taken on trust: a field that
 * is not what it claims is dropped rather than carried into the article.
 */
function readStyling(raw: string): StyleFragment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((entry) => {
      const f = entry as { text?: unknown; before?: unknown; styles?: unknown; style?: unknown; kind?: unknown };
      const style = Array.isArray(f.style) ? f.style : Array.isArray(f.styles) ? f.styles : [];
      return {
        text: typeof f.text === 'string' ? f.text.trim() : '',
        before: typeof f.before === 'string' ? f.before.trim() : '',
        style: style.filter((s): s is InlineStyle => STYLES.includes(s as InlineStyle)),
        kind: (KINDS.includes(f.kind as FragmentKind) ? f.kind : 'text') as FragmentKind
      };
    })
    .filter((f) => f.text.length > 0 && f.style.length > 0);
}

/** The page's size in points, if it is two sane numbers. */
function readPoints(raw: string): { w: number; h: number } | null {
  try {
    const parsed = JSON.parse(raw) as { w?: unknown; h?: unknown };
    const w = Number(parsed.w);
    const h = Number(parsed.h);
    return w > 0 && h > 0 && w < 20000 && h < 20000 ? { w, h } : null;
  } catch {
    return null;
  }
}

/** The page's own words, held to being words. */
function readWords(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((w): w is string => typeof w === 'string' && w.length > 0).slice(0, 20000);
  } catch {
    return [];
  }
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

  // The quarters the styling runs read, in reading order.
  const tiles: string[] = [];
  for (let i = 0; ; i++) {
    const tile = form.get(`tile${i}`);
    if (!(tile instanceof File)) break;
    tiles.push(await writeArtifact(id, `page-${pad2(page)}-t${i + 1}.jpeg`, Buffer.from(await tile.arrayBuffer())));
  }

  // What the browser read off the PDF's font table. Only the shape is trusted;
  // anything else in there is dropped rather than carried into the article.
  const styling = readStyling(String(form.get('styling') ?? '[]'));
  const words = readWords(String(form.get('words') ?? '[]'));
  const points = readPoints(String(form.get('points') ?? ''));
  const claimed = String(form.get('typography') ?? '');
  const typography: TypographySource = SOURCES.includes(claimed as TypographySource)
    ? (claimed as TypographySource)
    : 'no-text-layer';

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
      dpi: meta[i].dpi,
      ...(Number.isInteger(meta[i].parts) && Number(meta[i].parts) > 1 ? { parts: Number(meta[i].parts) } : {}),
      // The browser points at the merged picture by its place in the list; ids are
      // given here, by the same place.
      ...(meta[i].partOf === 'tekst'
        ? { partOf: 'tekst' }
        : Number.isInteger(meta[i].partOf) && Number(meta[i].partOf) >= 0 && Number(meta[i].partOf) < meta.length
          ? { partOf: `img-${page}-${pad2(Number(meta[i].partOf) + 1)}` }
          : {})
    });
  }

  job.pages = [
    ...job.pages.filter((p) => p.page !== page),
    { page, width, height, image: imageName, thumb: thumbName, tiles, styling, typography, words, ...(points ? { points } : {}) }
  ].sort(
    (a, b) => a.page - b.page
  );
  job.images = [...job.images.filter((img) => img.page !== page), ...ripped].sort(
    (a, b) => a.page - b.page || a.id.localeCompare(b.id)
  );
  job.status = job.pages.length >= job.pageCount ? 'ready' : 'uploading';
  await saveJob(job);

  return NextResponse.json({ page, status: job.status, uploaded: job.pages.length, images: ripped.length });
}
