import type { Block, ContentNode, InlineStyle, PageBlock, Patch, StyleSpan } from './types';

/**
 * Emphasis is contrast with its own surroundings, so it cannot cover those
 * surroundings. A sidebar is normally set heavier than the article around it;
 * that makes the BOX heavy, not its words bold, and the few words that really
 * stand out only stand out because the rest of the box is not marked too.
 *
 * The running column is the other way around. An interviewer's question is a
 * whole paragraph set heavier (often in another face) than the answers around
 * it, and a page holds several of those. That is still emphasis: the unmarked
 * answers are what it stands against. It only reads as the face of the type
 * when those marks swallow the column, and unmarked body is the exception.
 */
const PAGE = 'pagina';
/** In a box, one whole-block mark is already the face of that box. */
const BOX_WHOLE_LIMIT = 1;
/** In the running column, more than half the paragraphs wholly marked. */
const PAGE_FACE_SHARE = 0.5;
/** Under this length a block is too short to call a mark on it "the whole block". */
const WHOLE_BLOCK_MIN = 30;
/** How much of a block a fragment must cover to count as the whole of it. */
const WHOLE_BLOCK_SHARE = 0.9;

interface Accepted {
  index: number;
  block: Block;
  span: StyleSpan;
}

/**
 * The styling run's patches meet the reading-order run's page here, and nowhere else. A style patch is
 * applied only when the fragment really occurs in the block it names; anything
 * else is refused and shown as refused, rather than quietly changing the text.
 */
export function applyStyles(
  blocks: Block[],
  patches: Patch[]
): { content: ContentNode[]; warnings: string[]; dropped: number[] } {
  const warnings: string[] = [];
  const dropped: number[] = [];
  const accepted: Accepted[] = [];

  patches.forEach((patch, i) => {
    const find = patch.find.trim();
    const block = blocks.find((b) => b.id === patch.target) ?? blocks.find((b) => holds(b, find));

    if (!block || !holds(block, find)) {
      warnings.push(`styling "${clip(find)}" komt niet voor in ${patch.target}`);
      dropped.push(i);
      return;
    }
    if (block.type !== 'paragraph' && block.type !== 'insert' && block.type !== 'list') {
      // Headings, quotes and streamers carry their styling through their role.
      dropped.push(i);
      return;
    }
    accepted.push({ index: i, block, span: { text: find, style: patch.style, nth: patch.nth } });
  });

  // A mark that swallows the blocks around it is the face of the type, not a mark.
  const face = faceOfTheType(accepted, blocks);
  const spans = new Map<string, StyleSpan[]>();

  for (const entry of accepted) {
    const refused = face.get(container(entry.block));
    const style = refused ? entry.span.style.filter((s) => !refused.has(s)) : entry.span.style;

    if (!style.length) {
      const marks = entry.span.style.join(' en ');
      warnings.push(
        `${marks} "${clip(entry.span.text)}" geweigerd: hele alinea's ${
          entry.block.type === 'insert' ? 'van dit kader' : 'van deze kolom'
        } zijn zo gemeld, dus dit is het snijden van de tekst en geen nadruk`
      );
      dropped.push(entry.index);
      continue;
    }
    spans.set(entry.block.id, [...(spans.get(entry.block.id) ?? []), { text: entry.span.text, style }]);
  }

  const content = blocks.map((block) => toNode(block, spans.get(block.id) ?? [], block.id));
  return { content, warnings, dropped };
}

/**
 * What a mark is measured against: a box is its own world, everything else is
 * the running text of the page. Emphasis is local, so the share that decides
 * whether a mark is emphasis has to be local too.
 */
function container(block: Block): string {
  return block.type === 'insert' ? block.id : 'pagina';
}

/** Per container, the marks that swallow whole blocks and so are its face. */
function faceOfTheType(accepted: Accepted[], blocks: Block[]): Map<string, Set<InlineStyle>> {
  const whole = new Map<string, Map<InlineStyle, number>>();

  for (const entry of accepted) {
    if (!coversWholeBlock(entry.block, entry.span.text)) continue;
    const key = container(entry.block);
    const per = whole.get(key) ?? new Map<InlineStyle, number>();
    for (const style of entry.span.style) per.set(style, (per.get(style) ?? 0) + 1);
    whole.set(key, per);
  }

  const eligible = new Map<string, number>();
  for (const block of blocks) {
    if (block.type === 'insert') {
      eligible.set(block.id, (block.children ?? []).filter(isBody).length);
    } else if (isBody(block)) {
      eligible.set(PAGE, (eligible.get(PAGE) ?? 0) + 1);
    }
  }

  const face = new Map<string, Set<InlineStyle>>();
  for (const [key, per] of whole) {
    const denom = eligible.get(key) ?? 0;
    for (const [style, count] of per) {
      const swallowed = key === PAGE ? denom > 0 && count / denom > PAGE_FACE_SHARE : count >= BOX_WHOLE_LIMIT;
      if (!swallowed) continue;
      const set = face.get(key) ?? new Set<InlineStyle>();
      set.add(style);
      face.set(key, set);
    }
  }
  return face;
}

/**
 * The strings of a block that can actually carry inline styling, in printed
 * order. A box's own title is NOT one of them: it is a heading, it takes its
 * weight from its role, and a mark found there can never be painted - but it
 * would still be the first place a search hits, and the fragment it hands back
 * then lands somewhere else entirely. Which is exactly how a sidebar opening on
 * "Kerndoelen" ended up with the word bold three paragraphs further down.
 */
export function styleableTexts(block: PageBlock): string[] {
  if (block.type === 'paragraph') return block.text ? [block.text] : [];
  if (block.type === 'list') return [...(block.items ?? [])];
  if (block.type === 'insert') return (block.children ?? []).flatMap(styleableTexts);
  return [];
}

/**
 * Which of those strings a span belongs to, and which occurrence inside it.
 * `nth` counts over all of them in order, so the caller that found the mark and
 * the renderer that paints it are counting the same things in the same order.
 */
export function placeSpan(texts: string[], span: StyleSpan): { at: number; nth: number } | null {
  let wanted = span.nth ?? 0;
  for (let at = 0; at < texts.length; at++) {
    const inside = count(texts[at], span.text);
    if (wanted < inside) return { at, nth: wanted };
    wanted -= inside;
  }
  return null;
}

function count(text: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) n++;
  return n;
}

function isBody(block: PageBlock): boolean {
  return block.type === 'paragraph' || block.type === 'list';
}

/**
 * Does this fragment cover a whole block rather than something inside one? For
 * a box that question is asked of the blocks in it, never of its title, which
 * is a heading and carries its weight through its role.
 */
function coversWholeBlock(block: Block, find: string): boolean {
  const inside = block.type === 'insert' ? block.children ?? [] : [block];
  const needle = find.trim();

  return inside.some((child) => {
    if (child.type !== 'paragraph' && child.type !== 'list') return false;
    const text = (child.type === 'list' ? (child.items ?? []).join(' ') : child.text).trim();
    if (text.length < WHOLE_BLOCK_MIN || !text.includes(needle)) return false;
    return needle.length >= text.length * WHOLE_BLOCK_SHARE;
  });
}

/**
 * Asked of the text that can carry a mark, and of nothing else. A box's title
 * holds plenty of words that also appear in its paragraphs; accepting a patch
 * because the TITLE contains the fragment means accepting one that can never be
 * painted where it was meant.
 */
function holds(block: PageBlock, find: string): boolean {
  return styleableTexts(block).some((text) => text.includes(find));
}

/**
 * One block into one node. `id` is the addressable id it belongs to: the blocks
 * inside a box have none of their own, so they carry the box's.
 *
 * A span is placed rather than searched for. Filtering the box's spans by which
 * of its paragraphs happen to contain the words is what put a mark on the wrong
 * paragraph, and on every other paragraph that held the same word besides.
 */
function toNode(block: PageBlock, spans: StyleSpan[], id: string): ContentNode {
  const texts = styleableTexts(block);
  // Per string of this block, the spans that belong to it, renumbered so the
  // occurrence they name is counted inside that string alone.
  const placed = texts.map<StyleSpan[]>(() => []);
  for (const span of spans) {
    const where = placeSpan(texts, span);
    if (where) placed[where.at].push({ ...span, nth: where.nth });
  }
  return build(block, placed, id, { next: 0 });
}

/** Walks the block in the same order `styleableTexts` did, handing out its share. */
function build(block: PageBlock, placed: StyleSpan[][], id: string, cursor: { next: number }): ContentNode {
  switch (block.type) {
    case 'subheading':
      return { type: 'subheading', content: block.text };
    case 'quote':
      return { type: 'quote', content: block.text };
    case 'streamer':
      return { type: 'streamer', content: block.text };
    case 'list':
      return {
        type: 'list',
        ordered: Boolean(block.ordered),
        items: (block.items ?? []).map((text) => ({ content: text, styles: placed[cursor.next++] ?? [] }))
      };
    case 'image':
      return {
        type: 'image',
        id,
        file: block.file ?? null,
        caption: block.caption ?? null,
        credit: block.credit ?? null,
        size: block.size ?? 'normal'
      };
    case 'insert':
      // De kop die de leesvolgorde-run in de marker zet, wordt het eerste blok van het kader.
      return {
        type: 'insert',
        kind: 'box',
        background: block.background ?? null,
        ink: block.ink ?? null,
        content: [
          ...(block.text ? [{ type: 'subheading' as const, content: block.text }] : []),
          ...(block.children ?? []).map((child) => build(child, placed, id, cursor))
        ]
      };
    default:
      return { type: 'paragraph', content: block.text, styles: placed[cursor.next++] ?? [] };
  }
}

function clip(text: string): string {
  return text.length > 30 ? `${text.slice(0, 30)}…` : text;
}
