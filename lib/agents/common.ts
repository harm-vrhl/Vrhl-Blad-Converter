import { readArtifactAsDataUrl } from '../store';
import type { Ledger, JsonSchema } from '../llm/openai';
import type { Block } from '../types';

export interface AgentCtx {
  jobId: string;
  ledger: Ledger;
  /** What the runs before this one already established about the article. */
  context: string;
}

export async function pageImageUrl(jobId: string, file: string): Promise<string> {
  return readArtifactAsDataUrl(jobId, file, file.endsWith('.png') ? 'image/png' : 'image/jpeg');
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
      if (b.type === 'insert') {
        return `[${b.id}] (insert) ${b.text}\n${(b.paragraphs ?? []).join('\n')}`;
      }
      if (b.type === 'image') return `[${b.id}] (image) ${b.caption ?? ''}`;
      return `[${b.id}] (${b.type}) ${b.text}`;
    })
    .join('\n\n');
}
