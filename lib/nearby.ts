/**
 * De tekst die direct naast een beeld gedrukt staat.
 *
 * Op een pagina met zes portretten naast elkaar is het gezicht niet wat zegt wie
 * het is, maar de naam eronder. Een model dat de pagina bekijkt en een lijst
 * beelden met coördinaten krijgt, moet die koppeling raden, en raadt soms mis.
 * De tekstlaag van de PDF weet het gewoon: welke regels er onder, boven of naast
 * het beeld staan. Dat wordt hier opgemeten, zodat de beeldbeoordeling en de leesvolgorde-run
 * het beeld bij de juiste naam of het juiste bijschrift houden.
 *
 * Alle maten in PDF-punten, met de oorsprong linksboven, zoals `placed`.
 */

export interface PlacedText {
  x: number;
  /** Bovenkant van de regel. */
  y: number;
  w: number;
  h: number;
  str: string;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Hoe ver onder of boven het beeld een regel nog bij het beeld hoort. */
const REACH = 36;
/** Hoe ver ernaast. */
const SIDE = 18;
/** Hoeveel regels er meegaan: een naam over twee regels, of een kort bijschrift. */
const LINES = 3;
const MAX_CHARS = 140;

export function textNear(box: Box, texts: PlacedText[]): string | null {
  const overlapX = (t: PlacedText) => Math.min(t.x + t.w, box.x + box.w) - Math.max(t.x, box.x);
  const overlapY = (t: PlacedText) => Math.min(t.y + t.h, box.y + box.h) - Math.max(t.y, box.y);
  const across = (t: PlacedText) => overlapX(t) >= Math.min(t.w, box.w) * 0.4;

  const bottom = box.y + box.h;
  const below = texts.filter((t) => across(t) && t.y >= bottom - 2 && t.y <= bottom + REACH);
  if (below.length) return lines(below, 'down');

  const above = texts.filter((t) => across(t) && t.y + t.h <= box.y + 2 && t.y + t.h >= box.y - REACH);
  if (above.length) return lines(above, 'up');

  const beside = texts.filter(
    (t) =>
      overlapY(t) >= Math.min(t.h, box.h) * 0.5 &&
      ((t.x >= box.x + box.w - 2 && t.x <= box.x + box.w + SIDE) || (t.x + t.w <= box.x + 2 && t.x + t.w >= box.x - SIDE))
  );
  if (beside.length) return lines(beside, 'down');
  return null;
}

/** Stukjes op dezelfde hoogte zijn één regel; de dichtstbijzijnde regels gaan mee. */
function lines(texts: PlacedText[], direction: 'down' | 'up'): string | null {
  const rows: PlacedText[][] = [];
  for (const t of [...texts].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.find((r) => Math.abs(r[0].y - t.y) < Math.max(2, t.h * 0.4));
    if (row) row.push(t);
    else rows.push([t]);
  }
  rows.sort((a, b) => a[0].y - b[0].y);
  const picked = direction === 'down' ? rows.slice(0, LINES) : rows.slice(-LINES);
  const text = picked
    .map((row) =>
      row
        .sort((a, b) => a.x - b.x)
        .map((t) => t.str)
        .join(' ')
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text;
}
