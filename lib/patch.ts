import type { Block, ContentNode, Patch, StyleSpan } from './types';

/**
 * Run 2's patches meet run 1's page here, and nowhere else. A style patch is
 * applied only when the fragment really occurs in the block it names; anything
 * else is refused and shown as refused, rather than quietly changing the text.
 */
export function applyStyles(
  blocks: Block[],
  patches: Patch[]
): { content: ContentNode[]; warnings: string[]; dropped: number[] } {
  const warnings: string[] = [];
  const dropped: number[] = [];
  const spans = new Map<string, StyleSpan[]>();

  patches.forEach((patch, i) => {
    const find = patch.find.trim();
    const block = blocks.find((b) => b.id === patch.target) ?? blocks.find((b) => holds(b, find));

    if (!block || !holds(block, find)) {
      warnings.push(`styling "${clip(find)}" komt niet voor in ${patch.target}`);
      dropped.push(i);
      return;
    }
    if (block.type !== 'paragraph' && block.type !== 'insert') {
      // Headings, quotes and streamers carry their styling through their role.
      dropped.push(i);
      return;
    }
    spans.set(block.id, [...(spans.get(block.id) ?? []), { text: find, style: patch.style }]);
  });

  const content = blocks.map((block) => toNode(block, spans.get(block.id) ?? []));
  return { content, warnings, dropped };
}

function holds(block: Block, find: string): boolean {
  if (block.text.includes(find)) return true;
  return (block.paragraphs ?? []).some((p) => p.includes(find));
}

function toNode(block: Block, spans: StyleSpan[]): ContentNode {
  switch (block.type) {
    case 'subheading':
      return { type: 'subheading', content: block.text };
    case 'quote':
      return { type: 'quote', content: block.text };
    case 'streamer':
      return { type: 'streamer', content: block.text };
    case 'image':
      return {
        type: 'image',
        id: block.id,
        file: block.file ?? null,
        caption: block.caption ?? null,
        credit: block.credit ?? null
      };
    case 'insert':
      return {
        type: 'insert',
        kind: 'box',
        title: block.text || null,
        content: (block.paragraphs ?? []).map((text) => ({
          type: 'paragraph',
          content: text,
          styles: spans.filter((span) => text.includes(span.text))
        }))
      };
    default:
      return { type: 'paragraph', content: block.text, styles: spans };
  }
}

function clip(text: string): string {
  return text.length > 30 ? `${text.slice(0, 30)}…` : text;
}
