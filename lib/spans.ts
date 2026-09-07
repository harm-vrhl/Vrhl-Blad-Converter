import type { InlineStyle, StyleSpan } from './types';

export interface Segment {
  text: string;
  style: InlineStyle[];
}

/** One order for every consumer, so bold italic is never written two ways. */
export const STYLE_ORDER: InlineStyle[] = ['bold', 'italic', 'underline'];
const ORDER = STYLE_ORDER;

const WORD = /[\p{L}\p{N}]/u;

/**
 * Where the nth occurrence of `needle` starts, or -1 when there are too few.
 *
 * Only places where the fragment stands as its own word count. The placer checks
 * this too, but it checks it against one page's blocks, and by the time a mark is
 * painted the text may have grown: two halves of a sentence torn over a page break
 * are joined into one paragraph, and then a two-letter fragment that was fine on
 * its own page can find itself inside a longer word. That is how "In" came to set
 * the middle of "ging" in bold.
 */
function occurrence(text: string, needle: string, nth: number): number {
  const at = places(text, needle)[nth];
  return at === undefined ? -1 : at;
}

/**
 * Elke plek waar `needle` als eigen woord staat, op volgorde.
 *
 * Zowel het verven als het terugleggen van een markering telt hierlangs, en dat
 * moet dezelfde telling zijn. Telde de een alle tekens en de ander alleen hele
 * woorden, dan wijst hetzelfde `nth`-getal bij de twee naar iets anders - en dan
 * verdwijnt een cursieve "t" in "d's en t's" zonder dat iemand ziet waarom.
 */
export function places(text: string, needle: string): number[] {
  if (!needle) return [];
  const opensOnWord = WORD.test(needle[0] ?? '');
  const closesOnWord = WORD.test(needle[needle.length - 1] ?? '');
  const out: number[] = [];

  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    const end = at + needle.length;
    if (opensOnWord && at > 0 && WORD.test(text[at - 1])) continue;
    if (closesOnWord && end < text.length && WORD.test(text[end])) continue;
    out.push(at);
  }
  return out;
}


/**
 * Run 2 reports styled fragments; the preview and the MDX writer both have to
 * lay them back over the paragraph, and they have to agree. That is settled
 * here, once.
 *
 * Styling stacks. A word can be bold AND italic, and a passage set in italic
 * can hold a bold name inside it, so the styles are painted onto the characters
 * they cover and unioned where they meet - rather than one fragment winning and
 * the other being thrown away. Two fragments that report the same word, one
 * bold and one italic, and one fragment that reports both at once, therefore
 * come out the same.
 */
export function segments(text: string, spans: StyleSpan[]): Segment[] {
  if (!text) return [];

  const paint: Array<Set<InlineStyle> | undefined> = new Array(text.length);
  let painted = false;

  for (const span of spans) {
    if (!span.text || !span.style.length) continue;
    const at = occurrence(text, span.text, span.nth ?? 0);
    if (at < 0) continue;
    for (let i = at; i < at + span.text.length; i++) {
      const styles = (paint[i] ??= new Set<InlineStyle>());
      for (const style of span.style) styles.add(style);
    }
    painted = true;
  }
  if (!painted) return [{ text, style: [] }];

  // Characters carrying the same set of styles are one segment.
  const keys = Array.from(text, (_, i) => ORDER.filter((style) => paint[i]?.has(style)).join('+'));
  const out: Segment[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i < text.length && keys[i] === keys[start]) continue;
    out.push({ text: text.slice(start, i), style: ORDER.filter((style) => paint[start]?.has(style)) });
    start = i;
  }
  return out;
}
