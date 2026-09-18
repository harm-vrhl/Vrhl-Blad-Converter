'use client';

import { packageFiles, slug, toPackage, type Asset, type Pakket } from '../canonical';
import { toDocx, type DocxBeeld } from '../docx';
import { toHtml } from '../html';
import { toMdx } from '../mdx';
import type { PushResult } from '../sanity/push';
import type { ArticleDocument, OcrPage, PageResult } from '../types';
import { zip, type ZipEntry } from '../zip';
import { getData, getFile, type StoredJob } from './db';
import { BLAD_META, BLAD_OCR, BLAD_PAGES, BLAD_VERSIE, bladPaginaPad, type BladMeta, type BladPagina } from './blad';
import { postJson, runForm } from './post';
import { errorMessage } from '../util';

/**
 * De uitvoer van een artikel: als JSON, HTML, MDX, Word, PDF of .blad, en
 * hetzelfde pakket naar Vrhl-Blad-Studio (Sanity). Alles gaat uit van het artikel zoals het nu op
 * het scherm staat, met de correcties erin, en alles leest hetzelfde pakket:
 * wat in het .blad-bestand staat, staat ook in de losse JSON, en daar komen HTML, MDX en
 * Word weer uit.
 */

export type ExportFormaat = 'json' | 'html' | 'mdx' | 'docx' | 'pdf' | 'blad';

/** Wat als bestand wordt gedownload; PDF gaat via het printvenster, zie `printPdf`. */
export type DownloadFormaat = Exclude<ExportFormaat, 'pdf'>;

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
  formaat: DownloadFormaat
): Promise<{ blob: Blob; name: string }> {
  if (formaat === 'blad') return packageBlad(job, document);
  const pakket = await packageOf(job, document);
  const naam = `${baseName(job)}.${formaat}`;
  switch (formaat) {
    case 'json':
      return { blob: new Blob([`${JSON.stringify(pakket, null, 2)}\n`], { type: 'application/json' }), name: naam };
    case 'mdx':
      return { blob: new Blob([toMdx(pakket)], { type: 'text/markdown;charset=utf-8' }), name: naam };
    case 'html':
      return { blob: new Blob([await htmlOf(job, pakket)], { type: 'text/html;charset=utf-8' }), name: naam };
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

/** De HTML-export, met het beeld in het bestand zelf, zodat hij ook los van het .blad-bestand werkt. */
async function htmlOf(job: StoredJob, pakket: Pakket): Promise<string> {
  const beeld = await imagesOf(job, pakket);
  const dataUrls = new Map([...beeld].map(([id, b]) => [id, dataUrl(b)]));
  return toHtml(pakket, (item: Asset) => dataUrls.get(item.id) ?? null);
}

/**
 * Het artikel als PDF, via het printvenster van de browser.
 *
 * Bewust geen PDF die in code wordt opgebouwd. De lettertypen die in elke PDF
 * zitten kennen alleen West-Europese tekens, en de artikelen in het archief hebben
 * er meer: het eindteken ■ (in 6 van de 113), een pijl, een Turkse ş in een naam.
 * Die zouden vraagtekens worden, en een ander schrift (Grieks, Arabisch, Thai) kan
 * elk moment in een artikel staan. Printen doet de browser met de lettertypen van
 * het systeem, dus elk teken klopt, en de PDF ziet eruit als de HTML-export.
 *
 * De HTML gaat in een onzichtbaar iframe, wacht tot al het beeld geladen is (anders
 * print je lege vlakken), en opent dan het printvenster, waarin de redacteur
 * "Opslaan als PDF" kiest. Chrome noemt het bestand naar de titel van de pagina,
 * dus die staat tijdens het printen op de titel van het artikel.
 */
export async function printPdf(job: StoredJob, artikel: ArticleDocument): Promise<void> {
  const html = await htmlOf(job, await packageOf(job, artikel));
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const frame = window.document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  // Klein en buiten beeld, maar niet `display: none`: dan print de browser niets.
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';

  const vorigeTitel = window.document.title;
  let opgeruimd = false;
  const opruimen = () => {
    if (opgeruimd) return;
    opgeruimd = true;
    window.document.title = vorigeTitel;
    frame.remove();
    URL.revokeObjectURL(url);
  };

  try {
    await new Promise<void>((klaar, fout) => {
      frame.onload = () => klaar();
      frame.onerror = () => fout(new Error('de pagina om te printen kon niet worden geladen'));
      frame.src = url;
      window.document.body.appendChild(frame);
    });
    const venster = frame.contentWindow;
    const pagina = frame.contentDocument;
    if (!venster || !pagina) throw new Error('het printvenster kon niet worden geopend');

    await Promise.all([...pagina.images].map((img) => img.decode().catch(() => undefined)));
    await pagina.fonts?.ready;

    window.document.title = pagina.title || vorigeTitel;
    venster.addEventListener('afterprint', () => setTimeout(opruimen, 0), { once: true });
    // Vangnet voor een browser die geen afterprint stuurt; lang genoeg om rustig te bewaren.
    setTimeout(opruimen, 10 * 60 * 1000);
    venster.focus();
    venster.print();
  } catch (err) {
    opruimen();
    throw err;
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

/**
 * Het artikel plus de paginascan, als `.blad`. Intern een ZIP: `pakket.json` en
 * het beeld van het artikel, en ernaast de pagina's (voor de Controle-tab).
 * Zonder het beeld van het artikel gaat hij de deur niet uit.
 */
export async function packageBlad(job: StoredJob, document: ArticleDocument): Promise<{ blob: Blob; name: string }> {
  const pakket = await packageOf(job, document);
  const entries: ZipEntry[] = [
    { path: 'pakket.json', data: new TextEncoder().encode(`${JSON.stringify(pakket, null, 2)}\n`) }
  ];
  const ontbreekt: string[] = [];
  for (const file of packageFiles(pakket, job.images ?? [])) {
    const blob = await getFile(job.id, file.source);
    if (!blob) {
      ontbreekt.push(file.path);
      continue;
    }
    entries.push({ path: file.path, data: new Uint8Array(await blob.arrayBuffer()) });
  }
  if (ontbreekt.length) {
    throw new Error(
      ontbreekt.length === 1
        ? `het beeld ${ontbreekt[0]} ontbreekt; een .blad-bestand gaat alleen mee met al het beeld erin`
        : `${ontbreekt.length} beelden ontbreken; een .blad-bestand gaat alleen mee met al het beeld erin`
    );
  }

  await packPaginas(job, entries);

  return {
    blob: new Blob([zip(entries) as BlobPart], { type: 'application/zip' }),
    name: `${baseName(job)}.blad`
  };
}

/** De paginascan en de controlestukken, naast het canonieke pakket. */
async function packPaginas(job: StoredJob, entries: ZipEntry[]): Promise<void> {
  const pages: BladPagina[] = [];
  for (const page of job.pages ?? []) {
    const imageName = page.image.replace(/^.*\//, '');
    const thumbName = page.thumb.replace(/^.*\//, '');
    const image = await getFile(job.id, page.image);
    if (!image) continue;
    entries.push({ path: bladPaginaPad(imageName), data: new Uint8Array(await image.arrayBuffer()) });
    const thumb = await getFile(job.id, page.thumb);
    if (thumb && thumbName !== imageName) {
      entries.push({ path: bladPaginaPad(thumbName), data: new Uint8Array(await thumb.arrayBuffer()) });
    }
    pages.push({
      page: page.page,
      width: page.width,
      height: page.height,
      ...(page.points ? { points: page.points } : {}),
      image: imageName,
      thumb: thumb ? thumbName : imageName
    });
  }

  const pagesJson = await getData<PageResult[]>(job.id, 'pages.json');
  if (pagesJson) {
    entries.push({
      path: BLAD_PAGES,
      data: new TextEncoder().encode(`${JSON.stringify(pagesJson)}\n`)
    });
  }
  const ocr = await getData<OcrPage[]>(job.id, 'ocr.json');
  if (ocr) {
    entries.push({
      path: BLAD_OCR,
      data: new TextEncoder().encode(`${JSON.stringify(ocr)}\n`)
    });
  }

  if (!pages.length && !job.verdicts?.length && !pagesJson && !ocr) return;
  const meta: BladMeta = {
    blad: BLAD_VERSIE,
    pages,
    ...(job.verdicts?.length ? { verdicts: job.verdicts } : {})
  };
    entries.push({ path: BLAD_META, data: new TextEncoder().encode(`${JSON.stringify(meta, null, 2)}\n`) });
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
