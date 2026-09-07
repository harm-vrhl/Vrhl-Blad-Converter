export interface Piece {
  text: string;
  /** Absent for ordinary text; always http(s) for a link. */
  href?: string;
}

/**
 * A printed web address is a pattern, not a judgement, so no model is asked
 * about it: the text run 1 copied off the page is scanned here and the preview
 * and the MDX writer both read the result, so a link is a link in both.
 *
 * The visible text stays exactly as printed - "www.vrhl-blad.nl" is not
 * rewritten to its href - because the page is the source of truth for what it
 * says. Only the target is completed.
 */

/** The top-level domains a magazine here actually prints. */
const TLD = 'nl|be|com|org|net|eu|de|fr|uk|info|io|co|nu|tv|me|app|dev|blog|news|art';

const ADDRESS = new RegExp(
  // With a scheme or a www, the address speaks for itself.
  String.raw`(?:https?:\/\/|www\.)[^\s<>"'\]]+` +
    '|' +
    // Bare domain: only against a known ending, so "o.a." and "bijv." are safe.
    // It may not begin mid-token either, or the tail of an e-mail address would
    // be torn off and linked on its own.
    String.raw`(?<![\w@.\-/])[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:${TLD})\b(?:\/[^\s<>"'\]]*)?`,
  'gi'
);

export function linkify(text: string): Piece[] {
  const out: Piece[] = [];
  let cursor = 0;

  for (const match of text.matchAll(ADDRESS)) {
    const at = match.index ?? 0;
    if (at < cursor) continue;
    const address = trimTail(match[0]);
    if (!address) continue;

    if (at > cursor) out.push({ text: text.slice(cursor, at) });
    out.push({ text: address, href: target(address) });
    cursor = at + address.length;
  }

  if (cursor < text.length) out.push({ text: text.slice(cursor) });
  return out.length ? out : [{ text }];
}

/**
 * The sentence the address sits in ends somewhere, and that punctuation is not
 * part of the address. A bracket counts as the page's, not the link's, unless
 * it was opened inside the address itself.
 */
function trimTail(match: string): string {
  let out = match;
  for (;;) {
    const before = out;
    out = out.replace(/[.,;:!?…"'’”»]+$/, '');
    const opened = (out.match(/\(/g) ?? []).length;
    const closed = (out.match(/\)/g) ?? []).length;
    if (closed > opened) out = out.replace(/\)+$/, '');
    if (out === before) return out;
  }
}

/** Only ever http or https: nothing else can come out of this. */
function target(address: string): string {
  if (/^https?:\/\//i.test(address)) return address;
  return `https://${address}`;
}
