'use client';

import type { PDFPageProxy, PageViewport } from 'pdfjs-dist';
import { findMosaics, MIN_KEPT, TEXT_GUARD, type Box, type TextRun } from '../mosaic';
import { textNear, type PlacedText } from '../nearby';
import { withTimeout } from '../util';

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
  /** Set on a picture rendered from the page out of this many sliced pieces. */
  parts?: number;
  /**
   * Set on a piece of a sliced picture: the index, in the same list, of the
   * picture made from it. `tekst` when the pieces could not be merged without a
   * text box ending up in the picture, and they are left out altogether.
   */
  partOf?: number | 'tekst';
  /** De tekst die er direct onder, boven of naast staat: een naam, een bijschrift. */
  nearby?: string;
}

/** The page as it was rendered, to see what is drawn around a sliced picture. */
export interface PageRaster {
  canvas: HTMLCanvasElement;
  /** Canvas pixels per page point. */
  scale: number;
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
/** Above this, ripping the native bitmap can freeze the tab for minutes. */
const RIP_MAX_EDGE = 4096;
const RIP_MAX_PIXELS = 12_000_000;
const OBJ_TIMEOUT_MS = 20_000;
/** A merged picture is rendered at print resolution, up to this long edge. */
const MOSAIC_DPI = 300;
const MOSAIC_MAX_EDGE = 3600;
const MOSAIC_TIMEOUT_MS = 60_000;

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
  viewport: PageViewport,
  raster?: PageRaster
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
    if (bitmap.width * bitmap.height > RIP_MAX_PIXELS * 4) continue;

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

    let canvas: HTMLCanvasElement;
    try {
      canvas = draw(bitmap);
    } catch {
      continue;
    }
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

  if (raster && out.length >= 3) await mergeMosaics(pdfjs, page, viewport, raster, out);

  // Welke tekst er bij elk beeld staat, voor wie het moet plaatsen.
  if (out.length) {
    const content = await page.getTextContent().catch(() => null);
    const texts: PlacedText[] = (content?.items ?? []).flatMap((item) => {
      if (!('str' in item) || !item.str.trim()) return [];
      const t = pdfjs.Util.transform(viewport.transform, item.transform) as number[];
      const h = Math.hypot(t[2], t[3]);
      return [{ x: t[4], y: t[5] - h, w: item.width * viewport.scale, h, str: item.str }];
    });
    for (const image of out) {
      const near = textNear(image.placed, texts);
      if (near) image.nearby = near;
    }
  }
  return out;
}

/**
 * A map or an infographic sliced into dozens of bitmaps becomes one picture
 * again: the block its pieces cover, grown over what is drawn around them, is
 * rendered from the page. Its pieces stay in the list, pointing at it, so the
 * rules can say why they are not placed.
 */
async function mergeMosaics(
  pdfjs: typeof import('pdfjs-dist'),
  page: PDFPageProxy,
  viewport: PageViewport,
  raster: PageRaster,
  out: RippedImage[]
): Promise<void> {
  const content = await page.getTextContent().catch(() => null);
  const runs: TextRun[] = (content?.items ?? []).flatMap((item) => {
    if (!('str' in item) || !item.str.trim()) return [];
    const t = pdfjs.Util.transform(viewport.transform, item.transform) as number[];
    const h = Math.hypot(t[2], t[3]);
    return [{ x: t[4], y: t[5] - h, w: item.width * viewport.scale, h, chars: item.str.trim().length }];
  });

  const context = raster.canvas.getContext('2d');
  if (!context) return;
  const pixels = (area: Box) => {
    const x = Math.max(0, Math.floor(area.x * raster.scale));
    const y = Math.max(0, Math.floor(area.y * raster.scale));
    const w = Math.min(raster.canvas.width, Math.ceil((area.x + area.w) * raster.scale)) - x;
    const h = Math.min(raster.canvas.height, Math.ceil((area.y + area.h) * raster.scale)) - y;
    if (w <= 0 || h <= 0) return null;
    return { data: context.getImageData(x, y, w, h).data, width: w, height: h };
  };

  const mosaics = findMosaics(out, runs, { page: { w: viewport.width, h: viewport.height }, pixels });
  for (const mosaic of mosaics) {
    const mergeable =
      mosaic.textInside <= TEXT_GUARD && mosaic.kept >= MIN_KEPT && mosaic.box.w >= 20 && mosaic.box.h >= 20;
    if (!mergeable) {
      for (const i of mosaic.members) out[i].partOf = 'tekst';
      continue;
    }
    const merged = await renderRegion(page, viewport, mosaic.box).catch(() => null);
    // A render that fails leaves the pieces as they were; the model still judges them.
    if (!merged) continue;
    const index = out.length;
    out.push({ ...merged, parts: mosaic.members.length });
    for (const i of mosaic.members) out[i].partOf = index;
  }
}

async function renderRegion(page: PDFPageProxy, pageViewport: PageViewport, box: Box): Promise<RippedImage> {
  const scale = Math.min(MOSAIC_DPI / 72, MOSAIC_MAX_EDGE / Math.max(box.w, box.h));
  const viewport = page.getViewport({ scale, offsetX: -box.x * scale, offsetY: -box.y * scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(box.w * scale));
  canvas.height = Math.max(1, Math.round(box.h * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas niet beschikbaar');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  // 'print' for the same reason as the page render: a background tab must not stall it.
  await withTimeout(
    page.render({ canvasContext: context, viewport, intent: 'print' }).promise,
    MOSAIC_TIMEOUT_MS,
    `samengesteld beeld op pagina ${page.pageNumber}`
  );
  const placed = { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) };
  return {
    width: canvas.width,
    height: canvas.height,
    placed,
    areaPct: +((100 * placed.w * placed.h) / (pageViewport.width * pageViewport.height)).toFixed(2),
    dpi: Math.round(canvas.width / (box.w / 72)),
    full: await toBlob(canvas, 'image/jpeg'),
    thumb: await toBlob(downscale(canvas, THUMB), 'image/jpeg'),
    mime: 'image/jpeg'
  };
}

type PdfImage = { bitmap?: ImageBitmap; data?: Uint8ClampedArray; width: number; height: number; kind?: number };

async function resolve(page: PDFPageProxy, name: string): Promise<PdfImage | null> {
  try {
    const objs = page.objs as unknown as { get: (n: string, cb: (v: unknown) => void) => void };
    const value = await withTimeout(
      new Promise<unknown>((done) => objs.get(name, done)),
      OBJ_TIMEOUT_MS,
      `bitmap op pagina ${page.pageNumber}`
    );
    const image = value as PdfImage | null;
    if (!image || !image.width || !image.height) return null;
    return image;
  } catch {
    return null;
  }
}

function draw(image: PdfImage): HTMLCanvasElement {
  const scale = Math.min(
    1,
    RIP_MAX_EDGE / Math.max(image.width, image.height),
    Math.sqrt(RIP_MAX_PIXELS / (image.width * image.height))
  );
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas niet beschikbaar');

  if (image.bitmap) {
    context.drawImage(image.bitmap, 0, 0, width, height);
    return canvas;
  }

  // Older shape: raw samples, one of three pixel layouts. Only at native size when
  // it is still safe; otherwise the page would hang allocating hundreds of MB.
  if (scale < 1) throw new Error('bitmap te groot om te rippen');

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
