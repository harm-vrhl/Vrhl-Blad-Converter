'use client';

import { packageFiles, slug, toPackage, type Asset, type Pakket } from '../canonical';
import { toDocx, type DocxBeeld } from '../docx';
import { toHtml } from '../html';
import { toMdx } from '../mdx';
import type { PushResult } from '../sanity/push';
import type { ArticleDocument, PageResult } from '../types';
import { zip, type ZipEntry } from '../zip';
import { getData, getFile, type StoredJob } from './db';
import { postJson, runForm } from './post';
import { errorMessage } from '../util';

/**
 * De uitvoer van een artikel: als JSON, HTML, MDX, Word of pakket-ZIP, en
 * hetzelfde pakket naar Sanity. Alles gaat uit van het artikel zoals het nu op
 * het scherm staat, met de correcties erin, en alles leest hetzelfde pakket:
 * wat in de ZIP staat, staat ook in de losse JSON, en daar komen HTML, MDX en
 * Word weer uit.
 */

export type ExportFormaat = 'json' | 'html' | 'mdx' | 'docx' | 'zip';

/** Het pakket zoals het de deur uit gaat, met de woorddekking van de run erbij. */
export async function packageOf(job: StoredJob, document: ArticleDocument): Promise<Pakket> {
  // De woorddekking per pagina staat niet op het document maar naast de job, en
  // dat is waar `bron.betrouwbaarheid` vandaan komt.
  const pages = (await getData<PageResult[]>(job.id, 'pages.json')) ?? [];
  return toPackage(document, { images: job.images ?? [], pages, filename: job.filename });
}

/** Eén download: het artikel in het gekozen formaat, met de naam van de PDF. */
export async function exportFile(
  job: StoredJob,
  document: ArticleDocument,
  formaat: ExportFormaat
): Promise<{ blob: Blob; name: string }> {
  if (formaat === 'zip') return packageZip(job, document);
  const pakket = await packageOf(job, document);
  const naam = `${baseName(job)}.${formaat}`;
  switch (formaat) {
    case 'json':
      return { blob: new Blob([`${JSON.stringify(pakket, null, 2)}\n`], { type: 'application/json' }), name: naam };
    case 'mdx':
      return { blob: new Blob([toMdx(pakket)], { type: 'text/markdown;charset=utf-8' }), name: naam };
    case 'html': {
      // Het beeld zit in het bestand zelf, zodat het ook los van de ZIP werkt.
      const beeld = await imagesOf(job, pakket);
      const dataUrls = new Map([...beeld].map(([id, b]) => [id, dataUrl(b)]));
      const html = toHtml(pakket, (item: Asset) => dataUrls.get(item.id) ?? null);
      return { blob: new Blob([html], { type: 'text/html;charset=utf-8' }), name: naam };
    }
    case 'docx': {
      const beeld = await imagesOf(job, pakket);
      const bytes = toDocx(pakket, (item: Asset) => beeld.get(item.id) ?? null);
      return {
        blob: new Blob([bytes as BlobPart], {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        }),
        name: naam
      };
    }
  }
}

function baseName(job: StoredJob): string {
  return slug(job.filename.replace(/\.pdf$/i, '')) || 'artikel';
}

/** Het beeld van elk asset uit de opslag. Wat er niet (meer) is, of geen PNG of JPEG, ontbreekt. */
async function imagesOf(job: StoredJob, pakket: Pakket): Promise<Map<string, DocxBeeld>> {
  const uit = new Map<string, DocxBeeld>();
  for (const file of packageFiles(pakket, job.images ?? [])) {
    const item = (pakket.assets ?? []).find((a) => a.bestand === file.path);
    const blob = await getFile(job.id, file.source);
    if (!item || !blob) continue;
    const soort = item.mimeType ?? blob.type;
    const mimeType = soort === 'image/png' ? 'image/png' : soort === 'image/jpeg' ? 'image/jpeg' : null;
    if (!mimeType) continue;
    uit.set(item.id, { data: new Uint8Array(await blob.arrayBuffer()), mimeType });
  }
  return uit;
}

function dataUrl({ data, mimeType }: DocxBeeld): string {
  // In stukken, want String.fromCharCode met een hele foto tegelijk loopt tegen de stack aan.
  let binair = '';
  for (let i = 0; i < data.length; i += 0x8000) binair += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return `data:${mimeType};base64,${btoa(binair)}`;
}

/** pakket.json plus het beeld ernaast, in één ZIP, zoals een importer het wil. */
export async function packageZip(job: StoredJob, document: ArticleDocument): Promise<{ blob: Blob; name: string }> {
  const pakket = await packageOf(job, document);
  const entries: ZipEntry[] = [
    { path: 'pakket.json', data: new TextEncoder().encode(`${JSON.stringify(pakket, null, 2)}\n`) }
  ];
  for (const file of packageFiles(pakket, job.images ?? [])) {
    const blob = await getFile(job.id, file.source);
    // Een bitmap die er niet meer is houdt de rest niet tegen; het pakket
    // verwijst er dan naar zonder hem mee te leveren, en dat meldt de validator
    // van de andere kant met zoveel woorden.
    if (blob) entries.push({ path: file.path, data: new Uint8Array(await blob.arrayBuffer()) });
  }
  return { blob: new Blob([zip(entries) as BlobPart], { type: 'application/zip' }), name: `${baseName(job)}.zip` };
}

/**
 * Het artikel als concept naar Sanity: eerst elk beeld in een eigen verzoek,
 * dan het pakket met de id's die Sanity daarvoor gaf.
 */
export async function pushToSanity(
  job: StoredJob,
  document: ArticleDocument,
  onProgress?: (done: number, total: number) => void
): Promise<PushResult> {
  const pakket = await packageOf(job, document);
  const files = packageFiles(pakket, job.images ?? []);
  const assets: Record<string, string> = {};
  const warnings: string[] = [];

  for (let i = 0; i < files.length; i++) {
    onProgress?.(i, files.length);
    const file = files[i];
    const asset = (pakket.assets ?? []).find((a) => a.bestand === file.path);
    const blob = await getFile(job.id, file.source);
    if (!asset || !blob) continue;
    try {
      const result = await postJson<{ _id: string }>(
        '/api/sanity/asset',
        runForm(
          { naam: file.path.replace(/^assets\//, ''), mimeType: asset.mimeType },
          { bron: blob },
          `Het beeld ${file.path}`
        )
      );
      assets[asset.id] = result._id;
    } catch (err) {
      warnings.push(`asset '${asset.id}' kon niet worden geupload: ${errorMessage(err)}`);
    }
  }
  onProgress?.(files.length, files.length);

  const result = await postJson<PushResult>('/api/sanity/push', runForm({ pakket, assets }));
  return { ...result, warnings: [...warnings, ...result.warnings] };
}
