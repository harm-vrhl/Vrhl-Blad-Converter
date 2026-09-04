'use client';

import type { PDFPageProxy, PageViewport } from 'pdfjs-dist';

export interface RippedImage {
  /** Native pixel size of the bitmap as it is stored in the PDF. */
  width: number;
  height: number;
  /** Where it sits on the page, in PDF points. */
  placed: { x: number; y: number; w: number; h: number };
  /** Share of the page it covers, in percent. */
  areaPct: number;
  /** Effective resolution as printed. */
  dpi: number;
  full: Blob;
  thumb: Blob;
  mime: string;
}

type Matrix = [number, number, number, number, number, number];

const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5]
];

const apply = (m: Matrix, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5]
];

const THUMB = 360;

/**
 * Pull the embedded bitmaps straight out of the page instead of cropping them
 * back out of our own render. A magazine photo is stored at 300 dpi; rasterising
 * the page first and cutting it up afterwards throws most of that away.
 *
 * The current transformation matrix is tracked by hand, because the placement on
 * the page is what tells a photo apart from an ornament.
 */
export async function ripImages(
  pdfjs: typeof import('pdfjs-dist'),
  page: PDFPageProxy,
  viewport: PageViewport
): Promise<RippedImage[]> {
  const operators = await page.getOperatorList();
  const base = viewport.transform as Matrix;

  const out: RippedImage[] = [];
  const seen = new Set<string>();
  const stack: Matrix[] = [];
  let ctm: Matrix = [...base];

  for (let i = 0; i < operators.fnArray.length; i++) {
    const fn = operators.fnArray[i];
    const args = operators.argsArray[i] as unknown[];

    if (fn === pdfjs.OPS.save) {
      stack.push([...ctm]);
      continue;
    }
    if (fn === pdfjs.OPS.restore) {
      ctm = stack.pop() ?? ([...base] as Matrix);
      continue;
    }
    if (fn === pdfjs.OPS.transform) {
      ctm = multiply(ctm, args as unknown as Matrix);
      continue;
    }
    if (fn !== pdfjs.OPS.paintImageXObject && fn !== pdfjs.OPS.paintImageXObjectRepeat) continue;

    const name = args[0];
    if (typeof name !== 'string' || seen.has(name)) continue;
    seen.add(name);

    const bitmap = await resolve(page, name);
    if (!bitmap) continue;

    // The image fills the unit square, transformed onto the page.
    const corners = ([[0, 0], [1, 0], [0, 1], [1, 1]] as const).map(([x, y]) => apply(ctm, x, y));
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const placed = {
      x: Math.round(Math.min(...xs)),
      y: Math.round(Math.min(...ys)),
      w: Math.round(Math.max(...xs) - Math.min(...xs)),
      h: Math.round(Math.max(...ys) - Math.min(...ys))
    };
    if (placed.w < 1 || placed.h < 1) continue;

    const canvas = draw(bitmap);
    const transparent = hasAlpha(canvas);
    const mime = transparent ? 'image/png' : 'image/jpeg';

    out.push({
      width: canvas.width,
      height: canvas.height,
      placed,
      areaPct: +((100 * placed.w * placed.h) / (viewport.width * viewport.height)).toFixed(2),
      dpi: placed.w ? Math.round(canvas.width / (placed.w / 72)) : 0,
      full: await toBlob(canvas, mime),
      thumb: await toBlob(downscale(canvas, THUMB), mime),
      mime
    });
  }

  return out;
}

type PdfImage = { bitmap?: ImageBitmap; data?: Uint8ClampedArray; width: number; height: number; kind?: number };

async function resolve(page: PDFPageProxy, name: string): Promise<PdfImage | null> {
  try {
    const objs = page.objs as unknown as { get: (n: string, cb: (v: unknown) => void) => void };
    const value = await new Promise<unknown>((done) => objs.get(name, done));
    const image = value as PdfImage | null;
    if (!image || !image.width || !image.height) return null;
    return image;
  } catch {
    return null;
  }
}

function draw(image: PdfImage): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas niet beschikbaar');

  if (image.bitmap) {
    context.drawImage(image.bitmap, 0, 0);
    return canvas;
  }

  // Older shape: raw samples, one of three pixel layouts.
  const pixels = new Uint8ClampedArray(image.width * image.height * 4);
  const data = image.data ?? new Uint8ClampedArray(0);
  if (image.kind === 3) {
    pixels.set(data.subarray(0, pixels.length));
  } else if (image.kind === 2) {
    for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
      pixels[j] = data[i];
      pixels[j + 1] = data[i + 1];
      pixels[j + 2] = data[i + 2];
      pixels[j + 3] = 255;
    }
  } else {
    for (let i = 0; i < image.width * image.height; i++) {
      const bit = (data[i >> 3] >> (7 - (i & 7))) & 1;
      const value = bit ? 255 : 0;
      pixels[i * 4] = value;
      pixels[i * 4 + 1] = value;
      pixels[i * 4 + 2] = value;
      pixels[i * 4 + 3] = 255;
    }
  }
  context.putImageData(new ImageData(pixels, image.width, image.height), 0, 0);
  return canvas;
}

/** Cut-outs are common in magazines; flattening those onto black would ruin them. */
function hasAlpha(canvas: HTMLCanvasElement): boolean {
  const probe = downscale(canvas, 64);
  const context = probe.getContext('2d');
  if (!context) return true;
  const { data } = context.getImageData(0, 0, probe.width, probe.height);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) return true;
  }
  return false;
}

function downscale(source: HTMLCanvasElement, max: number): HTMLCanvasElement {
  const ratio = Math.min(1, max / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * ratio));
  canvas.height = Math.max(1, Math.round(source.height * ratio));
  canvas.getContext('2d')?.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, mime: string): Promise<Blob> {
  return new Promise((resolveBlob, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolveBlob(blob) : reject(new Error('afbeelding kon niet worden opgeslagen'))),
      mime,
      mime === 'image/jpeg' ? 0.92 : undefined
    );
  });
}
