
// Dutch words that legitimately follow a dangling hyphen ("kunst- en cultuurbeleid").
export const ELLIPSIS_FOLLOWERS = new Set(['en', 'of', 'noch', 'dan', 'tot', 'in', 'als']);

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

  // Mistral reads the page as markdown, so its emphasis markers travel with the
  // words. An italic passage is one wrap around the lines it was broken on;
  // those markers have to come off after the lines are one paragraph again, or
  // the opening and closing asterisks survive as printed characters. The words
  // stay and the markers go: typography is run 2's to decide, off the page image.
  // The content may not begin or end with a space, so "2 * 3 * 4" keeps its
  // asterisks. The edges of the content may not be the marker itself either, or
  // a closing "**" leaves one asterisk behind.
  text = text.replace(/\*{1,3}([^*\s](?:[^*]*[^*\s])?)\*{1,3}/g, '$1');
  text = text.replace(/~~([^~\s](?:[^~]*[^~\s])?)~~/g, '$1');
  text = text.replace(/`([^`]+?)`/g, '$1');
  // Underscores only away from word characters and slashes, or a URL would lose
  // part of its path.
  text = text.replace(/(?<![\w/])_{1,2}([^_\s](?:[^_]*[^_\s])?)_{1,2}(?![\w/])/g, '$1');

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
