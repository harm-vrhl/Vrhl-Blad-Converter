import { joinTorn } from './cleanup';
import { normalizeForCompare } from './util';
import type { ArticleDocument, ContentNode, Frontmatter, PageResult } from './types';

const PAGE_FURNITURE = /^(?:\d{1,4}|[ivxlcdm]{1,7}|pagina\s*\d+|blz\.?\s*\d+)$/i;

/**
 * The pages are strung together here and nowhere else. Where the text runs on,
 * the next page's first paragraph is glued straight onto the last one, no line
 * break, no new paragraph.
 */
export function compileArticle(
  frontmatter: Frontmatter,
  pages: PageResult[],
  source: { file: string; pages: number[] }
): { document: ArticleDocument; seams: number } {
  const ordered = [...pages].sort((a, b) => a.page - b.page);
  const noise = repeatedAcrossPages(ordered);
  // Title, chapeau, standfirst and intro belong to the frontmatter. On an
  // opening spread they sit inside the running text too, so they have to be
  // taken out of the body exactly once.
  const claimed = [frontmatter.title, frontmatter.subtitle, frontmatter.chapeau, frontmatter.intro]
    .map((value) => normalizeForCompare(value ?? ''))
    .filter(Boolean);
  // A credit line is often nothing but icons and names; the frontmatter has them.
  const names = [...frontmatter.authors, ...frontmatter.photographers, ...frontmatter.illustrators]
    .map((value) => normalizeForCompare(value))
    .filter(Boolean);

  const content: ContentNode[] = [];
  let seams = 0;
  for (const page of ordered) {
    const nodes = page.content.filter((node) => keep(node, noise, claimed, names));
    if (!nodes.length) continue;

    // The seam. A page break falls wherever the layout needed it, so the tail of
    // a sentence lands at the top of the next page - often with a photo above it.
    // Look past those floats on both sides for the two halves of the sentence.
    const at = lastParagraph(content);
    const next = firstParagraph(nodes);
    if (at >= 0 && next >= 0) {
      const previous = content[at];
      const opening = nodes[next];
      if (
        previous.type === 'paragraph' &&
        opening.type === 'paragraph' &&
        runsOn(previous.content, opening.content, page.continuity.continuesFromPrevious)
      ) {
        content[at] = {
          type: 'paragraph',
          content: joinTorn(previous.content, opening.content),
          styles: [...previous.styles, ...opening.styles]
        };
        nodes.splice(next, 1); // the floats that stood above it keep their place
        seams++;
      }
    }
    content.push(...nodes);
  }

  return { document: { source, frontmatter, content: pullsAfterSource(content) }, seams };
}

/**
 * A pull quote repeats a sentence from the running text, and it may never stand
 * in front of that sentence. The magazine prints it wherever the layout has room,
 * often at the top of a page while the sentence itself only follows halfway down
 * the next one, so this can only be settled once every page is strung together.
 */
function pullsAfterSource(content: ContentNode[]): ContentNode[] {
  const out = [...content];

  for (let i = 0; i < out.length; i++) {
    const node = out[i];
    if (node.type !== 'quote' && node.type !== 'streamer') continue;

    const needle = normalizeForCompare(node.content).replace(/^["'«»]+|["'«»]+$/g, '');
    if (needle.length < 12) continue;

    const source = out.findIndex((n) => n.type === 'paragraph' && normalizeForCompare(n.content).includes(needle));
    if (source < 0 || source < i) continue; // nowhere in the text, or already behind it

    out.splice(i, 1); // removing it shifts the source down one, so `source` is now just behind it
    out.splice(source, 0, node);
    i--;
  }

  return out;
}

/**
 * The last paragraph of what has been compiled so far, looking back past quotes,
 * images and boxes. A subheading is where it stops: past that lies another
 * section, and a sentence never runs across one.
 */
function lastParagraph(content: ContentNode[]): number {
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i].type === 'subheading') return -1;
    if (content[i].type === 'paragraph') return i;
  }
  return -1;
}

/** The first paragraph of the incoming page, past any float that opens it. */
function firstParagraph(nodes: ContentNode[]): number {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].type === 'subheading') return -1;
    if (nodes[i].type === 'paragraph') return i;
  }
  return -1;
}

/**
 * Do these two halves belong to one sentence? The text decides, not the model:
 * a paragraph never opens in lower case, and a word split by the page break
 * leaves its hyphen behind. Only where the text is ambiguous does the
 * continuity flag get a vote.
 */
function runsOn(previous: string, next: string, continues: boolean): boolean {
  const tail = previous.trimEnd();
  const head = next.replace(/^[\s"'\u2018\u2019\u201c\u201d\u00ab\u00bb(\[]+/u, '').charAt(0);
  if (!tail || !head) return false;

  if (/[-\u00ad]$/.test(tail)) return true; // a word cut in two by the break
  if (/\p{Ll}/u.test(head)) return true; // a new paragraph does not start lower case
  return continues && !/[.!?\u2026"'\u201d\u00bb)\]]$/.test(tail);
}

function keep(node: ContentNode, noise: Set<string>, claimed: string[], names: string[]): boolean {
  if (node.type !== 'paragraph' && node.type !== 'quote' && node.type !== 'streamer') return true;
  const key = normalizeForCompare(node.content);
  if (!key) return false;
  if (node.type === 'paragraph') {
    if (noise.has(key)) return false;
    if (PAGE_FURNITURE.test(node.content.trim())) return false;
    if (isCreditLine(key, names)) return false;
  }
  // Anything the frontmatter already carries must not appear in the body again.
  // An exact match always goes; a partial match only for text long enough that
  // the overlap cannot be a coincidence.
  if (claimed.some((value) => key === value)) return false;
  if (claimed.some((value) => value.length > 12 && (value.startsWith(key) || key.startsWith(value)))) return false;
  return true;
}

/** True when the line is made of nothing but the credited names. */
function isCreditLine(key: string, names: string[]): boolean {
  if (!names.length || key.length > 120) return false;
  let rest = key;
  for (const name of names) rest = rest.split(name).join(' ');
  return rest.trim().length === 0;
}

/** A short line that comes back on most pages is magazine furniture, not article. */
function repeatedAcrossPages(pages: PageResult[]): Set<string> {
  const counts = new Map<string, number>();
  for (const page of pages) {
    const seen = new Set<string>();
    for (const node of page.content) {
      if (node.type !== 'paragraph') continue;
      const key = normalizeForCompare(node.content);
      if (!key || key.length > 90 || seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const threshold = Math.max(2, Math.ceil(pages.length * 0.6));
  return new Set([...counts].filter(([, n]) => n >= threshold).map(([key]) => key));
}
