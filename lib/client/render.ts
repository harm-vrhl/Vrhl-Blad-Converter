'use client';

import { ripImages, type RippedImage } from './images';
import { readTypography, type TypographySource } from './typography';
import type { StyleFragment } from '../agents/styling';
import { errorMessage, withTimeout } from '../util';

export interface RenderedPage {
  page: number;
  width: number;
  height: number;
  image: Blob;
  thumb: Blob;
  /**
   * The page in quarters, with a little overlap. The vision API fits every
   * image it is given to 768px on its short side, so a whole page arrives with
   * roughly a five pixel x-height - too little to read a slant or a stroke off.
   * A quarter page spends that same budget on a quarter of the type.
   */
  tiles: Blob[];
  previewUrl: string;
  /** The bitmaps embedded in this page, at their own resolution. */
  ripped: RippedImage[];
  /**
   * The typography, read out of the PDF's own font table. Empty for a page with
   * no text layer - a scan, or an export that flattened its text - and then the
   * run that looks at the page image has to do the work instead.
   */
  styling: StyleFragment[];
  /** Whether that could be read at all, and if not, why not. */
  typography: TypographySource;
  /** Every word on the page as the file spells it. */
  words: string[];
  /** The page's size in points, the unit the ripped images are placed in. */
  points: { w: number; h: number };
}

const FULL_MAX = 1800; // the page as one image: layout, reading order, images
const THUMB_MAX = 320; // enough for "what does the neighbouring page look like"
const TILE_MAX = 2600; // the canvas the tiles are cut from, so each tile is dense
const TILE_GRID = 2; // 2 x 2 quarters
const TILE_OVERLAP = 0.08; // a line on a seam stays whole in one of the two
const RENDER_TIMEOUT_MS = 120_000;
const RIP_TIMEOUT_MS = 180_000;
const TYPE_TIMEOUT_MS = 60_000;

export type RenderStep = 'renderen' | 'beelden' | 'lettertypen';

/**
 * Rasterising happens in the browser: pdf.js already lives here and it keeps the
 * server free of native image dependencies.
 */
export async function renderPdf(
  file: File,
  onPage: (rendered: RenderedPage, total: number) => Promise<void> | void,
  onStep?: (page: number, total: number, step: RenderStep) => void
): Promise<number> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    try {
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(4, TILE_MAX / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('canvas niet beschikbaar');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);

      onStep?.(i, doc.numPages, 'renderen');
      // 'print' intent, not 'display': display rendering drives itself with
      // requestAnimationFrame, which a background tab suspends, the render would
      // then hang forever if the user looks away mid-document.
      await withTimeout(
        page.render({ canvasContext: context, viewport, intent: 'print' }).promise,
        RENDER_TIMEOUT_MS,
        `Pagina ${i} renderen`
      );

      const full = downscale(canvas, FULL_MAX);
      const image = await toBlob(full, 0.92);
      const thumb = await toBlob(downscale(canvas, THUMB_MAX), 0.8);
      const tiles: Blob[] = [];
      for (let row = 0; row < TILE_GRID; row++) {
        for (let col = 0; col < TILE_GRID; col++) {
          tiles.push(await toBlob(quarter(canvas, col, row), 0.92));
        }
      }

      onStep?.(i, doc.numPages, 'beelden');
      const ripped = await withTimeout(
        ripImages(pdfjs, page, page.getViewport({ scale: 1 }), { canvas, scale }),
        RIP_TIMEOUT_MS,
        `Pagina ${i} beelden rippen`
      );

      onStep?.(i, doc.numPages, 'lettertypen');
      // After the render, so the fonts it needed are already loaded and named.
      const typography = await withTimeout(
        readTypography(page as never).catch(
          () => ({ fragments: [], source: 'no-text-layer' as TypographySource, words: [] })
        ),
        TYPE_TIMEOUT_MS,
        `Pagina ${i} lettertypen lezen`
      );

      await onPage(
        {
          page: i,
          width: full.width,
          height: full.height,
          image,
          thumb,
          tiles,
          previewUrl: URL.createObjectURL(thumb),
          ripped,
          styling: typography.fragments,
          typography: typography.source,
          words: typography.words,
          points: { w: base.width, h: base.height }
        },
        doc.numPages
      );
    } catch (err) {
      const detail = errorMessage(err);
      throw new Error(`Pagina ${i}: ${detail}`);
    } finally {
      page.cleanup();
    }
  }

  return doc.numPages;
}

/** One tile of the grid, grown by the overlap on the sides that have room. */
function quarter(source: HTMLCanvasElement, col: number, row: number): HTMLCanvasElement {
  const width = source.width / TILE_GRID;
  const height = source.height / TILE_GRID;
  const padX = width * TILE_OVERLAP;
  const padY = height * TILE_OVERLAP;
  const left = Math.max(0, col * width - padX);
  const top = Math.max(0, row * height - padY);
  const right = Math.min(source.width, (col + 1) * width + padX);
  const bottom = Math.min(source.height, (row + 1) * height + padY);

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(right - left);
  canvas.height = Math.round(bottom - top);
  canvas
    .getContext('2d')
    ?.drawImage(source, left, top, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  return canvas;
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
