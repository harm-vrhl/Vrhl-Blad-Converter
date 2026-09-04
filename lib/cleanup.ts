
// Dutch words that legitimately follow a dangling hyphen ("kunst- en cultuurbeleid").
const ELLIPSIS_FOLLOWERS = new Set(['en', 'of', 'noch', 'dan', 'tot', 'in', 'als']);

/**
 * Step 12, Text Cleanup. Deterministic on purpose: this step must never be able
 * to change a word, so it is rules, not a model.
 */
export function cleanupText(input: string): string {
  let text = input;

  // OCR markdown artefacts that are not article content.
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^\s{0,3}>\s?/gm, '');

  // Repair words split by a line break, but keep genuine compound ellipses.
  text = text.replace(/(\p{Ll})[-­]\s*\n\s*(\p{L}+)/gu, (m, a: string, b: string) =>
    ELLIPSIS_FOLLOWERS.has(b.toLowerCase()) ? `${a}- ${b}` : `${a}${b}`
  );

  // Remaining single newlines are column/line wraps; blank lines are real breaks.
  text = text.replace(/\s*\n\s*/g, ' ');

  // A "continued overleaf" arrow at the very end of a block is page furniture.
  text = text.replace(/[\s]*[\u2192\u27f6\u2794\u279c\u25b6\u25ba]+[\s]*$/u, '');

  // Whitespace hygiene only, never punctuation, spelling or word choice.
  text = text.replace(/ /g, ' ').replace(/[ \t]{2,}/g, ' ').trim();

  return text;
}

/**
 * Two paragraphs were torn apart by a page or column break when the first has no
 * sentence-final punctuation, or the second picks up in lower case.
 */
export function looksTorn(prev: string, next: string): boolean {
  if (!prev || !next) return false;
  const tail = prev.trimEnd().slice(-1);
  const head = next.trimStart().charAt(0);
  const closed = /[.!?…:;»"'”)\]]/.test(tail);
  return !closed || /\p{Ll}/u.test(head);
}

export function joinTorn(prev: string, next: string): string {
  const a = prev.trimEnd();
  const b = next.trimStart();
  if (/[-­]$/.test(a)) return a.slice(0, -1) + b;
  return `${a} ${b}`;
}
