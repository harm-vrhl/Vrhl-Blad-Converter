import { places, segments, STYLE_ORDER } from '../spans';
import type { InlineStyle, StyleSpan } from '../types';

/**
 * Tekst die iemand in het voorbeeld heeft rechtgezet, terug in de vorm van het
 * artikel.
 *
 * Het Artikel-tabblad is de bewerkplek: je klikt in een alinea en typt. Wat de
 * browser daarna in de DOM heeft staan is tekst met `<b>`, `<i>` en `<u>` erin,
 * en dat moet weer `content` plus `styles` worden - dezelfde vorm die run 2
 * aflevert, zodat het canonieke pakket niet hoeft te weten dat er iemand aan
 * heeft gezeten.
 *
 * Markeringen worden per stijl als aaneengesloten stukken teruggeschreven en
 * met `places` geteld, dezelfde telling waarmee `segments` ze weer verft. Een
 * stuk dat midden in een woord begint of eindigt kan het formaat niet dragen;
 * dat valt weg in plaats van op de verkeerde plek te landen.
 */

export interface Marked {
  text: string;
  /** Per teken van `text`: de stijlen die erop staan. */
  marks: InlineStyle[][];
}

/** Wat er in een bewerkbaar element staat, als tekst met stijl per teken. */
export function readBack(root: HTMLElement): Marked {
  let raw = '';
  const rawMarks: InlineStyle[][] = [];

  const walk = (node: Node, styles: InlineStyle[]) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const chunk = (node.nodeValue ?? '').replace(/\s/g, ' ');
      raw += chunk;
      for (let i = 0; i < chunk.length; i++) rawMarks.push(styles);
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === 'BR') {
      raw += ' ';
      rawMarks.push([]);
      return;
    }

    const own = new Set(styles);
    const tag = node.tagName;
    if (tag === 'B' || tag === 'STRONG') own.add('bold');
    if (tag === 'I' || tag === 'EM') own.add('italic');
    if (tag === 'U') own.add('underline');
    // Een browser zet opmaak soms als inline stijl, en haalt hem zo ook weg.
    const { fontWeight, fontStyle, textDecorationLine } = node.style;
    if (fontWeight === 'bold' || Number(fontWeight) >= 600) own.add('bold');
    else if (fontWeight === 'normal' || (fontWeight && Number(fontWeight) < 600)) own.delete('bold');
    if (fontStyle === 'italic') own.add('italic');
    else if (fontStyle === 'normal') own.delete('italic');
    if (textDecorationLine.includes('underline')) own.add('underline');

    const next = STYLE_ORDER.filter((style) => own.has(style));
    node.childNodes.forEach((child) => walk(child, next));
  };
  root.childNodes.forEach((child) => walk(child, []));

  // Dubbele spaties en witruimte aan de randen tellen niet: die typt niemand
  // met opzet in een alinea, en contenteditable laat ze graag achter.
  let text = '';
  const marks: InlineStyle[][] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === ' ' && (!text.length || text[text.length - 1] === ' ')) continue;
    text += raw[i];
    marks.push(rawMarks[i]);
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1);
    marks.pop();
  }
  return { text, marks };
}

/** De markeringen van een stuk tekst, alleen voor de stijlen die het veld kent. */
export function spansFrom({ text, marks }: Marked, allowed: readonly InlineStyle[]): StyleSpan[] {
  const out: StyleSpan[] = [];
  for (const style of STYLE_ORDER) {
    if (!allowed.includes(style)) continue;
    let i = 0;
    while (i < text.length) {
      if (!marks[i].includes(style)) {
        i++;
        continue;
      }
      let end = i;
      while (end < text.length && marks[end].includes(style)) end++;

      let from = i;
      let to = end;
      while (from < to && text[from] === ' ') from++;
      while (to > from && text[to - 1] === ' ') to--;
      if (from < to) {
        const piece = text.slice(from, to);
        const nth = places(text, piece).indexOf(from);
        if (nth > 0) out.push({ text: piece, style: [style], nth });
        else if (nth === 0) out.push({ text: piece, style: [style] });
      }
      i = end;
    }
  }
  return out;
}

/** Of twee versies er voor de lezer hetzelfde uitzien. */
export function looksSame(
  a: { text: string; spans: StyleSpan[] },
  b: { text: string; spans: StyleSpan[] }
): boolean {
  return JSON.stringify(segments(a.text, a.spans)) === JSON.stringify(segments(b.text, b.spans));
}
