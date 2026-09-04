'use client';

import { ripImages, type RippedImage } from './images';

export interface RenderedPage {
  page: number;
  width: number;
  height: number;
  image: Blob;
  thumb: Blob;
  previewUrl: string;
  /** The bitmaps embedded in this page, at their own resolution. */
  ripped: RippedImage[];
}

const FULL_MAX = 1800; // enough detail for the vision runs
const THUMB_MAX = 320; // enough for "what does the neighbouring page look like"

/**
 * Rasterising happens in the browser: pdf.js already lives here and it keeps the
 * server free of native image dependencies.
 */
export async function renderPdf(
  file: File,
  onPage: (rendered: RenderedPage, total: number) => Promise<void> | void
): Promise<number> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, FULL_MAX / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas niet beschikbaar');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    // 'print' intent, not 'display': display rendering drives itself with
    // requestAnimationFrame, which a background tab suspends, the render would
    // then hang forever if the user looks away mid-document.
    await page.render({ canvasContext: context, viewport, intent: 'print' }).promise;

    const image = await toBlob(canvas, 0.92);
    const thumb = await toBlob(downscale(canvas, THUMB_MAX), 0.8);
    const ripped = await ripImages(pdfjs, page, page.getViewport({ scale: 1 }));

    await onPage(
      {
        page: i,
        width: canvas.width,
        height: canvas.height,
        image,
        thumb,
        previewUrl: URL.createObjectURL(thumb),
        ripped
      },
      doc.numPages
    );
    page.cleanup();
  }

  return doc.numPages;
}

function downscale(source: HTMLCanvasElement, max: number): HTMLCanvasElement {
  const ratio = Math.min(1, max / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * ratio));
  canvas.height = Math.max(1, Math.round(source.height * ratio));
  const context = canvas.getContext('2d');
  context?.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('render mislukt'))), 'image/jpeg', quality);
  });
}
