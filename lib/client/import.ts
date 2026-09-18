'use client';

import { fromPackage, parsePakket, type Pakket } from '../canonical';
import { frameTitlesAsHeadings } from '../compile';
import type { Job, OcrPage, PageAsset, PageResult } from '../types';
import { unzip } from '../zip';
import { BLAD_META, BLAD_OCR, BLAD_PAGES, bladPaginaPad, parseBladMeta, type BladMeta } from './blad';
import { newId, putData, putFile, saveJob, type StoredJob } from './db';

/** Een job die uit een .blad-bestand kwam, niet uit een PDF. */
export function isPakketJob(job: Job | StoredJob | null | undefined): boolean {
  return job?.origin === 'pakket';
}

/**
 * Wat je later weer opent: een .blad-bestand (artikel plus beeld). Een oude
 * .zip uit de eerste export telt ook mee. JSON wordt herkend om hem te
 * weigeren: daar zit geen beeld in.
 */
export function isPakketBestand(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith('.blad') || name.endsWith('.zip') || name.endsWith('.json');
}

export interface ImportResult {
  job: StoredJob;
  /** Beeld waar het pakket naar wijst maar dat niet in het bestand zat. */
  missing: string[];
  /** Artikelen in het pakket naast het eerste, dat we openen. */
  extra: number;
}

/**
 * Een eerder bewaard .blad-bestand terug in de opslag van deze browser: het
 * artikel, het beeld, en als ze meekwamen de pagina's en de controlestukken.
 * JSON wordt geweigerd: zonder beeld is het geen blad.
 */
export async function importPackage(file: File): Promise<ImportResult> {
  const { pakket, blobs, extra } = await readPakket(file);
  const gelezen = fromPackage(pakket);
  const document = frameTitlesAsHeadings(gelezen.document);
  const missing: string[] = [];
  const meta = metaVan(blobs);
  const job: StoredJob = {
    id: newId(),
    filename: document.source.file || file.name,
    status: 'done',
    pageCount: document.source.pages.length,
    pages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    error: null,
    images: gelezen.images,
    document,
    edited: null,
    verdicts: meta?.verdicts ?? [],
    totals: null,
    origin: 'pakket'
  };

  for (const asset of gelezen.files) {
    const bytes = blobAt(blobs, asset.path);
    if (!bytes) {
      missing.push(asset.path);
      continue;
    }
    const type = asset.path.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    await putFile(job.id, asset.name, new Blob([bytes as BlobPart], { type }));
  }

  if (gelezen.files.length && missing.length === gelezen.files.length) {
    throw new Error('in dit bestand zit geen beeld, terwijl het artikel er wel naar wijst. Bewaar het als .blad.');
  }

  job.pages = await unpackPaginas(job.id, blobs, meta);
  if (job.pages.length) job.pageCount = job.pages.length;

  const pagesJson = jsonVan<PageResult[]>(blobs, BLAD_PAGES);
  if (pagesJson) await putData(job.id, 'pages.json', pagesJson);
  const ocr = jsonVan<OcrPage[]>(blobs, BLAD_OCR);
  if (ocr) await putData(job.id, 'ocr.json', ocr);

  await saveJob(job);
  return { job, missing, extra };
}

async function unpackPaginas(
  jobId: string,
  blobs: Map<string, Uint8Array>,
  meta: BladMeta | null
): Promise<PageAsset[]> {
  const pages: PageAsset[] = [];
  for (const page of meta?.pages ?? []) {
    const image = blobAt(blobs, bladPaginaPad(page.image)) ?? blobAt(blobs, page.image);
    if (!image) continue;
    await putFile(jobId, page.image, new Blob([image as BlobPart], { type: 'image/jpeg' }));
    const thumbBytes =
      page.thumb === page.image
        ? image
        : (blobAt(blobs, bladPaginaPad(page.thumb)) ?? blobAt(blobs, page.thumb) ?? image);
    if (page.thumb !== page.image) {
      await putFile(jobId, page.thumb, new Blob([thumbBytes as BlobPart], { type: 'image/jpeg' }));
    }
    pages.push({
      page: page.page,
      width: page.width,
      height: page.height,
      ...(page.points ? { points: page.points } : {}),
      image: page.image,
      thumb: page.thumb
    });
  }
  return pages.sort((a, b) => a.page - b.page);
}

function metaVan(blobs: Map<string, Uint8Array>): BladMeta | null {
  const bytes = blobAt(blobs, BLAD_META);
  return bytes ? parseBladMeta(new TextDecoder().decode(bytes)) : null;
}

function jsonVan<T>(blobs: Map<string, Uint8Array>, path: string): T | null {
  const bytes = blobAt(blobs, path);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes).replace(/^\uFEFF/, '')) as T;
  } catch {
    return null;
  }
}

async function readPakket(file: File): Promise<{ pakket: Pakket; blobs: Map<string, Uint8Array>; extra: number }> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const name = file.name.toLowerCase();

  if (name.endsWith('.json') || looksLikeJson(buf)) {
    throw new Error('JSON heeft geen beeld. Bewaar het artikel als .blad en open dat.');
  }

  if (name.endsWith('.blad') || name.endsWith('.zip') || isZip(buf)) {
    const entries = await unzip(buf);
    const json = findPakketJson(entries);
    const root = json.path.replace(/pakket\.json$/i, '');
    const pakket = parsePakket(new TextDecoder().decode(json.data));
    const blobs = new Map<string, Uint8Array>();
    for (const entry of entries) {
      if (entry === json) continue;
      const relative = root && entry.path.startsWith(root) ? entry.path.slice(root.length) : entry.path;
      blobs.set(entry.path, entry.data);
      if (relative && relative !== entry.path) blobs.set(relative, entry.data);
    }
    return { pakket, blobs, extra: Math.max(0, (pakket.artikelen?.length ?? 1) - 1) };
  }

  throw new Error('een PDF om om te zetten, of een eerder bewaard .blad-bestand');
}

function blobAt(blobs: Map<string, Uint8Array>, path: string): Uint8Array | undefined {
  return blobs.get(path) ?? blobs.get(path.replace(/^\.\//, ''));
}

function findPakketJson(entries: Array<{ path: string; data: Uint8Array }>): { path: string; data: Uint8Array } {
  const matches = entries.filter((entry) => {
    const path = entry.path.toLowerCase();
    return path === 'pakket.json' || path.endsWith('/pakket.json');
  });
  if (!matches.length) {
    throw new Error('in dit bestand staat geen pakket.json. Exporteer het artikel als Blad.');
  }
  return matches.sort((a, b) => a.path.length - b.path.length)[0];
}

function isZip(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
}

function looksLikeJson(buf: Uint8Array): boolean {
  let i = 0;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) i = 3;
  while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d)) i++;
  return buf[i] === 0x7b;
}
