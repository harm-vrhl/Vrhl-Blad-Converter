'use client';

import type { OcrPage, RunEvent, RunUsage } from '../../types';
import { pad2 } from '../../util';
import { buildIndex } from '../../wordindex';
import { needFile, putData } from '../db';
import { BODY_LIMIT, postJson } from '../post';
import type { RunContext } from './context';

/** Een pagina-PDF groter dan dit gaat als render naar de OCR. */
const PDF_ROOM = BODY_LIMIT - 256 * 1024;

export type OcrRead = { ocr: OcrPage; swaps: string[]; usage: RunUsage };

/**
 * 1. Word index per page. Mistral decides which words exist; this is the
 *    yardstick every AI output is held against. Page by page, as a PDF of that
 *    one page: the whole file can be fifty megabytes.
 */
export async function* readWords(
  ctx: RunContext
): AsyncGenerator<RunEvent, { read: OcrRead[]; ocrByPage: Map<number, OcrPage> }, void> {
  const { id, ocrLane, assets, once, form } = ctx;
  yield { type: 'status', run: 'woordindex', state: 'start', detail: "Mistral leest alle pagina's" };
  let pdf: Promise<import('pdf-lib').PDFDocument> | null = null;
  const pagePdf = async (page: number): Promise<Blob> => {
    const { PDFDocument } = await import('pdf-lib');
    pdf ??= needFile(id, 'source.pdf')
      .then((blob) => blob.arrayBuffer())
      .then((bytes) => PDFDocument.load(bytes, { ignoreEncryption: true }));
    const from = await pdf;
    const out = await PDFDocument.create();
    const [copied] = await out.copyPages(from, [page - 1]);
    out.addPage(copied);
    return new Blob([(await out.save()) as BlobPart], { type: 'application/pdf' });
  };

  const read = await Promise.all(
    assets.map((asset) =>
      once(`ocr-p${pad2(asset.page)}`, () =>
        ocrLane(async () => {
          let bron = await pagePdf(asset.page);
          // A page with one enormous photo on it does not fit in a request as a
          // PDF; its render does, and reads just as well.
          if (bron.size > PDF_ROOM) bron = await needFile(id, asset.image);
          return postJson<{ ocr: OcrPage; swaps: string[]; usage: RunUsage }>(
            '/api/run/ocr',
            form({ page: asset.page, words: asset.words ?? [] }, { bron }, `Pagina ${asset.page} voor de OCR`)
          );
        })
      )
    )
  );
  await putData(id, 'ocr.json', read.map((r) => r.ocr));
  const corrected = read.flatMap((r) => r.swaps);
  if (corrected.length) {
    yield { type: 'status', run: 'woordindex', state: 'ok', detail: `spelling uit de PDF: ${corrected.join(', ')}` };
  }
  const ocrByPage = new Map(read.map((r) => [r.ocr.page, r.ocr]));
  const words = read.reduce((n, r) => n + buildIndex(r.ocr.page, r.ocr.markdown).total, 0);
  yield { type: 'status', run: 'woordindex', state: 'ok', detail: `${read.length} pagina(s), ${words} woorden` };
  return { read, ocrByPage };
}
