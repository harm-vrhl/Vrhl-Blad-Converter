'use client';

import { packageFiles, slug, toPackage, type Pakket } from '../canonical';
import type { PushResult } from '../sanity/push';
import type { ArticleDocument, PageResult } from '../types';
import { zip, type ZipEntry } from '../zip';
import { getData, getFile, type StoredJob } from './db';
import { postJson, runForm } from './post';
import { errorMessage } from '../util';

/**
 * De uitvoer van een artikel: het canonieke pakket als ZIP, en hetzelfde pakket
 * naar Sanity. Beide gaan uit van het artikel zoals het nu op het scherm staat,
 * met de correcties erin.
 */

/** Het pakket zoals het de deur uit gaat, met de woorddekking van de run erbij. */
export async function packageOf(job: StoredJob, document: ArticleDocument): Promise<Pakket> {
  // De woorddekking per pagina staat niet op het document maar naast de job, en
  // dat is waar `bron.betrouwbaarheid` vandaan komt.
  const pages = (await getData<PageResult[]>(job.id, 'pages.json')) ?? [];
  return toPackage(document, { images: job.images ?? [], pages, filename: job.filename });
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
  const name = slug(job.filename.replace(/\.pdf$/i, '')) || 'pakket';
  return { blob: new Blob([zip(entries) as BlobPart], { type: 'application/zip' }), name: `${name}.zip` };
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
