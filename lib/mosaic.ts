/**
 * An infographic, a map or a cut-out illustration often does not reach the PDF as
 * one bitmap. The export slices it into strips and blocks, sometimes a hundred of
 * them, and every one of those is ripped as an image of its own. Placed in an
 * article one by one they are shards.
 *
 * This finds those mosaics from where the pieces sit: pieces that touch or overlap
 * belong together, and a group in which no piece fills most of the block is a
 * picture that was cut up, not a photo with a logo on it.
 *
 * What it must not do is glue a text box onto the picture next to it. The panel
 * and the soft shadow behind a box are bitmaps too, and they touch the map beside
 * them. Their pixels do not give them away (a shadow and the grey edge of a map
 * measure the same), but their place does: they lie against running text. So the
 * text layer marks where the text blocks are, and a piece against one is left out.
 *
 * The pieces only say roughly where the picture is. Its title, its legend, a
 * circle drawn behind it are vectors; so the rendered page is read, and what is
 * drawn and attached to the pieces decides the block that is rendered as one.
 *
 * Rules, not a model. The pixels come from the caller: in the browser the page
 * canvas. Test against a pdf.js render; another renderer places the page a few
 * points differently.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One run of text from the text layer, in the same page points as the images. */
export interface TextRun extends Box {
  chars: number;
}

export interface MosaicPiece {
  placed: Box;
  areaPct: number;
}

export interface Mosaic {
  /** Indexes into the pieces that were passed in. */
  members: number[];
  /**
   * The block to render, kept clear of text boxes. A piece can run on underneath a
   * box that is printed over it; rendering that corner would put the first letters
   * of the box's lines in the picture.
   */
  box: Box;
  /** What share of the pieces' own block survived that; very little means do not merge. */
  kept: number;
  /** Characters of text inside the block. A lot means a text box would be cut in. */
  textInside: number;
}

/** Pieces this close count as touching: a slice seam is never exactly zero. */
const GAP = 1.5;
/** Covering this much of the page it is a background, and everything touches it. */
const BACKGROUND_PCT = 60;
/** A group is a mosaic only if no single piece fills this much of the block. */
const DOMINANT = 0.6;
const MIN_PIECES = 3;
/**
 * A text block this long is running text, not a label. A legend, a map title or
 * the axis of a chart stays well under it.
 */
const RUNNING_TEXT = 150;
/** How far around running text a box's panel and shadow reach. */
const PANEL_MARGIN = 36;
/** More text than this inside a block, and merging it would cut a text box in. */
export const TEXT_GUARD = 250;
/** Less of the block than this left after keeping clear of text, and it is not merged. */
export const MIN_KEPT = 0.5;
/**
 * How far from running text the pieces' own block is cut back: a box's panel,
 * border and padding. Generous, because it is only the starting point.
 */
const CUT_MARGIN = 40;
/**
 * How close to running text the ink may be followed. A legend can sit closer to a
 * box than CUT_MARGIN, a box's border and shadow not much further out than this.
 */
const FOLLOW_MARGIN = 20;
/**
 * Running heads, folios, footer rules and the text up the side of the page live
 * in the margins, and a rule there touches everything it runs past. Ink is not
 * followed into them, unless the pieces themselves lie there: a bleed.
 */
const MARGIN_TOP_BOTTOM = 0.055;
const MARGIN_SIDES = 0.03;
/**
 * Type this large is a headline or a masthead, not the title of a chart: growing
 * stops at it, or a photo under the logo takes the logo with it.
 */
const DISPLAY_TYPE = 20;
/** The grid ink is followed on, in page points. */
const CELL = 2;
/** Ink this close counts as attached: a title under a map, a legend beside it. */
const LINK = 4;
/** How far beyond the pieces' own block the ink is followed, as a share of its size. */
const GROW_MAX = 0.3;
/** Room added around the result, over background only. */
const PADDING = 4;

/** Pixels of the rendered page, RGBA, for a rectangle in page points. */
export interface Pixels {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/**
 * Reads the rendered page. Given by the caller: in the browser it is the page
 * canvas, in a test a decoded render.
 */
export type PixelReader = (area: Box) => Pixels | null;

export interface MosaicOptions {
  page?: { w: number; h: number };
  pixels?: PixelReader;
}

export function findMosaics(pieces: MosaicPiece[], text: TextRun[], options: MosaicOptions = {}): Mosaic[] {
  const running = textBlocks(text).filter((block) => block.chars >= RUNNING_TEXT);
  const zones = running.map((block) => grow(block, PANEL_MARGIN));
  const cuts = running.map((block) => grow(block, CUT_MARGIN));
  const follow = running.map((block) => grow(block, FOLLOW_MARGIN));
  const stops = [
    ...follow,
    ...text.filter((run) => run.h >= DISPLAY_TYPE).map((run) => grow(run, 2))
  ];

  const eligible = pieces
    .map((piece, index) => ({ piece, index }))
    .filter(({ piece }) => piece.areaPct < BACKGROUND_PCT && !zones.some((zone) => overlaps(piece.placed, zone, 0)));

  const parent = eligible.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let a = 0; a < eligible.length; a++) {
    for (let b = a + 1; b < eligible.length; b++) {
      if (overlaps(eligible[a].piece.placed, eligible[b].piece.placed, GAP)) parent[find(a)] = find(b);
    }
  }

  const groups = new Map<number, number[]>();
  eligible.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));

  const out: Mosaic[] = [];
  for (const members of groups.values()) {
    if (members.length < MIN_PIECES) continue;
    const boxes = members.map((i) => eligible[i].piece.placed);
    const whole = union(boxes);
    const largest = Math.max(...boxes.map((b) => b.w * b.h));
    if (largest >= DOMINANT * whole.w * whole.h) continue;
    // The bitmaps are only part of a graphic: its title, its legend, a drawn circle
    // behind it are vectors and belong to it too. And a piece can be mostly white,
    // lying over something else. So the block is what is drawn and attached to the
    // pieces, followed across small gaps, stopping at a text box or a headline.
    const cleared = clear(whole, cuts);
    const followed =
      options.pixels && options.page && cleared.w > 0 && cleared.h > 0
        ? attachedInk(cleared, boxes, options.page, [...stops, ...margins(options.page, boxes)], follow, options.pixels)
        : null;
    const box = followed ? pad(followed, options.page!, cuts, options.pixels!) : cleared;
    out.push({
      members: members.map((i) => eligible[i].index).sort((a, b) => a - b),
      box,
      kept: (box.w * box.h) / (whole.w * whole.h),
      textInside: text.filter((run) => inside(center(run), box)).reduce((n, run) => n + run.chars, 0)
    });
  }
  return out;
}

/**
 * Runs of text that sit together: lines of one column, one after the other.
 * Two runs join when they are on the same line or the next one down and overlap
 * sideways; a gutter or a paragraph of white keeps blocks apart.
 */
export function textBlocks(runs: TextRun[]): TextRun[] {
  const usable = runs.filter((r) => r.chars > 0 && r.w > 0 && r.h > 0);
  const parent = usable.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let a = 0; a < usable.length; a++) {
    for (let b = a + 1; b < usable.length; b++) {
      const ra = usable[a];
      const rb = usable[b];
      const line = Math.max(ra.h, rb.h);
      const vertical = Math.max(ra.y, rb.y) - Math.min(ra.y + ra.h, rb.y + rb.h);
      const horizontal = Math.max(ra.x, rb.x) - Math.min(ra.x + ra.w, rb.x + rb.w);
      if (vertical <= line * 0.9 && horizontal <= line * 0.8) parent[find(a)] = find(b);
    }
  }
  const blocks = new Map<number, TextRun[]>();
  usable.forEach((run, i) => blocks.set(find(i), [...(blocks.get(find(i)) ?? []), run]));
  return [...blocks.values()].map((members) => ({
    ...union(members),
    chars: members.reduce((n, r) => n + r.chars, 0)
  }));
}

/**
 * The block with every text area taken off it, one side at a time: of the four
 * ways to move an edge out of the way, the one that keeps the most picture.
 */
function clear(box: Box, zones: Box[]): Box {
  let current = box;
  for (const zone of zones) {
    if (!overlaps(current, zone, 0)) continue;
    const x1 = current.x + current.w;
    const y1 = current.y + current.h;
    const options: Box[] = [
      { ...current, w: zone.x - current.x },
      { ...current, x: zone.x + zone.w, w: x1 - (zone.x + zone.w) },
      { ...current, h: zone.y - current.y },
      { ...current, y: zone.y + zone.h, h: y1 - (zone.y + zone.h) }
    ].filter((b) => b.w > 0 && b.h > 0);
    if (!options.length) return { ...current, w: 0, h: 0 };
    current = options.reduce((best, b) => (b.w * b.h > best.w * best.h ? b : best));
  }
  return current;
}

/**
 * Everything drawn that hangs together with the pieces. The page is read as a grid
 * of small cells; a cell with any ink in it is ink. Starting from the ink on the
 * pieces themselves, ink is followed to ink within LINK points, never into a text
 * area, and never further than GROW_MAX beyond the pieces' block. The result is
 * the box around what was reached, with a straight rule along an edge taken off:
 * that is the border of something else.
 */
function attachedInk(
  start: Box,
  seeds: Box[],
  page: { w: number; h: number },
  stops: Box[],
  cuts: Box[],
  read: PixelReader
): Box | null {
  const area = {
    x: Math.max(0, start.x - start.w * GROW_MAX),
    y: Math.max(0, start.y - start.h * GROW_MAX),
    w: 0,
    h: 0
  };
  area.w = Math.min(page.w, start.x + start.w * (1 + GROW_MAX)) - area.x;
  area.h = Math.min(page.h, start.y + start.h * (1 + GROW_MAX)) - area.y;
  const pixels = read(area);
  if (!pixels || !pixels.width || !pixels.height) return null;

  const cols = Math.ceil(area.w / CELL);
  const rows = Math.ceil(area.h / CELL);
  const perX = pixels.width / area.w;
  const perY = pixels.height / area.h;
  const background = modeColour([pixels.data]);
  const ink = new Uint8Array(cols * rows);
  for (let y = 0; y < pixels.height; y++) {
    const row = Math.min(rows - 1, Math.floor(y / perY / CELL));
    for (let x = 0; x < pixels.width; x++) {
      if (distance(pixels.data, (y * pixels.width + x) * 4, background) <= INK) continue;
      ink[row * cols + Math.min(cols - 1, Math.floor(x / perX / CELL))] = 1;
    }
  }

  const centre = (c: number, r: number) => ({ x: area.x + (c + 0.5) * CELL, y: area.y + (r + 0.5) * CELL });
  const blocked = (c: number, r: number) => stops.some((zone) => inside(centre(c, r), zone));
  const seen = new Uint8Array(cols * rows);
  const queue: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!ink[r * cols + c] || blocked(c, r)) continue;
      if (seeds.some((seed) => inside(centre(c, r), seed))) {
        seen[r * cols + c] = 1;
        queue.push(r * cols + c);
      }
    }
  }
  if (!queue.length) return null;

  const reach = Math.ceil(LINK / CELL);
  let minC = cols;
  let minR = rows;
  let maxC = -1;
  let maxR = -1;
  while (queue.length) {
    const cell = queue.pop() as number;
    const c = cell % cols;
    const r = (cell - c) / cols;
    minC = Math.min(minC, c);
    maxC = Math.max(maxC, c);
    minR = Math.min(minR, r);
    maxR = Math.max(maxR, r);
    for (let dr = -reach; dr <= reach; dr++) {
      for (let dc = -reach; dc <= reach; dc++) {
        const nc = c + dc;
        const nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const next = nr * cols + nc;
        if (seen[next] || !ink[next] || blocked(nc, nr)) continue;
        seen[next] = 1;
        queue.push(next);
      }
    }
  }

  // Kept clear of text boxes first, so that what lies against the picture on the
  // side of a box is at its edge when the bands below are looked for.
  const reached = clear(
    { x: area.x + minC * CELL, y: area.y + minR * CELL, w: (maxC - minC + 1) * CELL, h: (maxR - minR + 1) * CELL },
    cuts
  );
  if (reached.w <= 0 || reached.h <= 0) return null;
  minC = Math.max(minC, Math.floor((reached.x - area.x) / CELL));
  maxC = Math.min(maxC, Math.ceil((reached.x + reached.w - area.x) / CELL) - 1);
  minR = Math.max(minR, Math.floor((reached.y - area.y) / CELL));
  maxR = Math.min(maxR, Math.ceil((reached.y + reached.h - area.y) / CELL) - 1);

  // A rule or a shadow along an edge: a band that fills nearly the whole side, with
  // next to nothing just inside it. That is the edge of something else, lying
  // against the picture: a box's shadow above it, a footer rule below.
  const filled = (fromC: number, toC: number, fromR: number, toR: number) => {
    let n = 0;
    for (let r = fromR; r <= toR; r++) for (let c = fromC; c <= toC; c++) n += seen[r * cols + c];
    return n / ((toC - fromC + 1) * (toR - fromR + 1));
  };
  const BAND = Math.ceil(24 / CELL);
  const FRINGE = Math.ceil(24 / CELL);
  for (let pass = 0; pass < 4; pass++) {
    let trimmed = false;
    for (const side of ['top', 'bottom', 'left', 'right'] as const) {
      const length = side === 'top' || side === 'bottom' ? maxR - minR : maxC - minC;
      if (length < 2 * BAND + 4) continue;
      const line = (k: number) =>
        side === 'top'
          ? filled(minC, maxC, minR + k, minR + k)
          : side === 'bottom'
            ? filled(minC, maxC, maxR - k, maxR - k)
            : side === 'left'
              ? filled(minC + k, minC + k, minR, maxR)
              : filled(maxC - k, maxC - k, minR, maxR);
      // Sparse marks can sit outside the band: a corner of the box's shadow, the tail
      // of a margin text. The band itself has to run nearly the whole side, as a
      // shadow or a rule does; a title under a map does not.
      let fringe = 0;
      while (fringe < FRINGE && line(fringe) < 0.2) fringe++;
      let k = fringe;
      while (k < fringe + BAND && line(k) > 0.8) k++;
      if (k === fringe || k >= fringe + BAND || line(k) >= 0.4) continue;
      if (side === 'top') minR += k;
      if (side === 'bottom') maxR -= k;
      if (side === 'left') minC += k;
      if (side === 'right') maxC -= k;
      // What was only attached through the band hangs in white now: take the
      // empty lines off as well.
      if (side === 'top') while (minR < maxR && filled(minC, maxC, minR, minR) === 0) minR++;
      if (side === 'bottom') while (maxR > minR && filled(minC, maxC, maxR, maxR) === 0) maxR--;
      if (side === 'left') while (minC < maxC && filled(minC, minC, minR, maxR) === 0) minC++;
      if (side === 'right') while (maxC > minC && filled(maxC, maxC, minR, maxR) === 0) maxC--;
      trimmed = true;
    }
    if (!trimmed) break;
  }

  // Lines with nothing reached on them at all, left over at an edge after cutting.
  const any = (fromC: number, toC: number, fromR: number, toR: number) => filled(fromC, toC, fromR, toR) > 0;
  while (minR < maxR && !any(minC, maxC, minR, minR)) minR++;
  while (maxR > minR && !any(minC, maxC, maxR, maxR)) maxR--;
  while (minC < maxC && !any(minC, minC, minR, maxR)) minC++;
  while (maxC > minC && !any(maxC, maxC, minR, maxR)) maxC--;

  return {
    x: area.x + minC * CELL,
    y: area.y + minR * CELL,
    w: (maxC - minC + 1) * CELL,
    h: (maxR - minR + 1) * CELL
  };
}

/**
 * A little room around it, over background only: an outline's soft edge is too
 * faint to count as ink and would otherwise be shaved off, and a box's border just
 * beyond the white is ink and stays out.
 */
/** The page margins no piece of this picture lies in. */
function margins(page: { w: number; h: number }, pieces: Box[]): Box[] {
  const top = page.h * MARGIN_TOP_BOTTOM;
  const side = page.w * MARGIN_SIDES;
  const bands: Box[] = [
    { x: 0, y: 0, w: page.w, h: top },
    { x: 0, y: page.h - top, w: page.w, h: top },
    { x: 0, y: 0, w: side, h: page.h },
    { x: page.w - side, y: 0, w: side, h: page.h }
  ];
  return bands.filter((band) => !pieces.some((piece) => overlaps(piece, band, -0.01)));
}

function pad(box: Box, page: { w: number; h: number }, cuts: Box[], read: PixelReader): Box {
  const out = { ...box };
  const bands: Array<[Box, (b: Box) => void]> = [
    [{ x: box.x - PADDING, y: box.y, w: PADDING, h: box.h }, (b) => ((b.x -= PADDING), (b.w += PADDING))],
    [{ x: box.x + box.w, y: box.y, w: PADDING, h: box.h }, (b) => (b.w += PADDING)],
    [{ x: box.x, y: box.y - PADDING, w: box.w, h: PADDING }, (b) => ((b.y -= PADDING), (b.h += PADDING))],
    [{ x: box.x, y: box.y + box.h, w: box.w, h: PADDING }, (b) => (b.h += PADDING)]
  ];
  for (const [band, apply] of bands) {
    if (band.x < 0 || band.y < 0 || band.x + band.w > page.w || band.y + band.h > page.h) continue;
    if (cuts.some((zone) => overlaps(band, zone, -0.01))) continue;
    const pixels = read(band);
    if (pixels && blankPixels(pixels.data)) apply(out);
  }
  return out;
}

/** How far from the background a pixel has to be to count as drawn. */
const INK = 60;

/**
 * Whether a patch of pixels is background only: every pixel within a small
 * distance of the most common colour. A hairline or the tip of a drawing counts.
 * Meant for a clean render of the page, which has no noise to allow for.
 */
export function blankPixels(rgba: Uint8ClampedArray | Uint8Array): boolean {
  if (!rgba.length) return true;
  const background = modeColour([rgba]);
  let ink = 0;
  for (let i = 0; i < rgba.length; i += 4) if (distance(rgba, i, background) > INK) ink++;
  // Counted, not a share: the tip of a map in a long strip is a dozen pixels.
  return ink < 4;
}

function modeColour(sources: Array<Uint8ClampedArray | Uint8Array>): [number, number, number] {
  const counts = new Map<number, number>();
  for (const rgba of sources) {
    for (let i = 0; i < rgba.length; i += 4) {
      const key = ((rgba[i] >> 4) << 8) | ((rgba[i + 1] >> 4) << 4) | (rgba[i + 2] >> 4);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let mode = 0;
  let most = -1;
  for (const [key, n] of counts) {
    if (n > most) {
      most = n;
      mode = key;
    }
  }
  return [((mode >> 8) << 4) + 8, (((mode >> 4) & 15) << 4) + 8, ((mode & 15) << 4) + 8];
}

function distance(rgba: Uint8ClampedArray | Uint8Array, i: number, colour: [number, number, number]): number {
  return Math.abs(rgba[i] - colour[0]) + Math.abs(rgba[i + 1] - colour[1]) + Math.abs(rgba[i + 2] - colour[2]);
}

function overlaps(a: Box, b: Box, gap: number): boolean {
  return a.x <= b.x + b.w + gap && b.x <= a.x + a.w + gap && a.y <= b.y + b.h + gap && b.y <= a.y + a.h + gap;
}

function union(boxes: Box[]): Box {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function grow(box: Box, by: number): Box {
  return { x: box.x - by, y: box.y - by, w: box.w + 2 * by, h: box.h + 2 * by };
}

function center(box: Box): { x: number; y: number } {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

function inside(point: { x: number; y: number }, box: Box): boolean {
  return point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h;
}
