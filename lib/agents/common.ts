import type { Ledger, JsonSchema } from '../llm/chat';
import type { Block, PageBlock } from '../types';

export interface AgentCtx {
  /**
   * Een beeld bij naam, als data-URL. De server bewaart niets meer: wat een run
   * wil zien, zit in het verzoek dat hem startte.
   */
  image: (name: string) => Promise<string>;
  ledger: Ledger;
  /** What the runs before this one already established about the article. */
  context: string;
}

export function pageImageUrl(ctx: AgentCtx, file: string): Promise<string> {
  return ctx.image(file);
}

/** Strict-mode object schema: every key required, nothing extra. */
export function obj(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

export function str(description: string): JsonSchema {
  return { type: 'string', description };
}

export function nullableStr(description: string): JsonSchema {
  return { type: ['string', 'null'], description };
}

export function strArray(description: string): JsonSchema {
  return { type: 'array', description, items: { type: 'string' } };
}

/** Run 1's page, addressable by block id, what run 2 hangs its patches on. */
export function blockList(blocks: Block[]): string {
  return blocks
    .map((b) => {
      // A box is one target, its own contents included: run 2 names the box and
      // the fragment, and the applier finds which line of it the fragment is in.
      if (b.type === 'insert') {
        const inside = (b.children ?? []).map((child) => bodyOf(child)).filter(Boolean).join('\n');
        return `[${b.id}] (insert) ${b.text}\n${inside}`;
      }
      if (b.type === 'image') return `[${b.id}] (image) ${b.caption ?? ''}`;
      return `[${b.id}] (${b.type}) ${b.text}`;
    })
    .join('\n\n');
}

function bodyOf(child: PageBlock): string {
  if (child.type === 'image') return child.caption ?? '';
  return child.text;
}
