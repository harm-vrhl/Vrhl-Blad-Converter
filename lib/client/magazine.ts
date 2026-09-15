'use client';

import { errorMessage, withTimeout } from '../util';

export interface ScannedPage {
  pdf: number;
  width: number;
  height: number;
  image: Blob;
  thumb: Blob;
  previewUrl: string;
  text: string;
  label: string | null;
}

/**
 * Big enough to read a headline, a rubric and a page number off; small enough to
 * send a hundred of. The article run renders its own pages again at full size.
 */
const IMAGE_MAX = 1400;
const THUMB_MAX = 320;
const RENDER_TIMEOUT_MS = 120_000;
/** Control characters mean a font without a usable encoding: that text is noise. */
const BROKEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

/**
 * A whole magazine, page by page: a picture and the text layer, and nothing of
 * the rest the article upload does. Finding where the articles are needs no
 * ripped bitmaps and no typography.
 */
export async function scanMagazine(
  file: File,
  onPage: (page: ScannedPage, total: number) => Promise<void> | void
): Promise<number> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const labels = await doc.getPageLabels().catch(() => null);

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    try {
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(3, IMAGE_MAX / Math.max(base.width, base.height)) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('canvas niet beschikbaar');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      // 'print', not 'display': see lib/client/render.ts. A background tab would
      // otherwise freeze the render of a hundred pages halfway.
      await withTimeout(
        page.render({ canvasContext: context, viewport, intent: 'print' }).promise,
        RENDER_TIMEOUT_MS,
        `Pagina ${i} renderen`
      );

      const content = await page.getTextContent().catch(() => null);
      const text = (content?.items ?? [])
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
        .join('')
        .replace(/\r\n?/g, '\n')
        .replace(BROKEN, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      const thumb = await toBlob(downscale(canvas, THUMB_MAX), 0.8);
      await onPage(
        {
          pdf: i,
          width: canvas.width,
          height: canvas.height,
          image: await toBlob(canvas, 0.85),
          thumb,
          previewUrl: URL.createObjectURL(thumb),
          text,
          label: labels?.[i - 1] ?? null
        },
        doc.numPages
      );
    } catch (err) {
      throw new Error(`Pagina ${i}: ${errorMessage(err)}`);
    } finally {
      page.cleanup();
    }
  }

  return doc.numPages;
}

/**
 * The pages of one article as a PDF of their own. Whole pages, copied as they
 * are: nothing is cropped or redrawn, so what the article run reads is exactly
 * what was in the magazine.
 */
export async function cutArticle(source: ArrayBuffer, pages: number[], filename: string): Promise<File> {
  const { PDFDocument } = await import('pdf-lib');
  const from = await PDFDocument.load(source, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const copied = await out.copyPages(
    from,
    pages.map((pdf) => pdf - 1)
  );
  for (const page of copied) out.addPage(page);
  const bytes = await out.save();
  return new File([bytes as BlobPart], filename, { type: 'application/pdf' });
}

function downscale(source: HTMLCanvasElement, max: number): HTMLCanvasElement {
  const ratio = Math.min(1, max / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * ratio));
  canvas.height = Math.max(1, Math.round(source.height * ratio));
  canvas.getContext('2d')?.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('render mislukt'))), 'image/jpeg', quality);
  });
}
