import { askJson } from '../llm/openai';
import type { Block, InlineStyle, StylePatch } from '../types';
import { promptFor } from '../prompts';
import { AgentCtx, blockList, obj, pageImageUrl, str, strArray } from './common';

const ALLOWED: InlineStyle[] = ['bold', 'italic', 'underline', 'strikethrough'];

const schema = obj({
  patches: {
    type: 'array',
    description: 'One entry per styled fragment. Empty if nothing is emphasised.',
    items: obj({
      target: str('Id of the block the fragment sits in, e.g. "p3-02".'),
      find: str('The fragment, copied character for character from that block.'),
      style: strArray('bold, italic, underline and/or strikethrough')
    })
  }
});

/**
 * Patch run: inline typography only. It never touches order or meaning, which is
 * exactly why it can look purely at the picture.
 */
export async function detectStyling(ctx: AgentCtx, page: number, image: string, blocks: Block[]): Promise<StylePatch[]> {
  if (!blocks.length) return [];

  const prompt = promptFor('styling');

  const result = await askJson<{ patches: Array<{ target: string; find: string; style: string[] }> }>({
    agent: `styling p${page}`,
    ledger: ctx.ledger,
    instructions: prompt.instructions,
    effort: prompt.effort,
    maxOutputTokens: prompt.maxOutputTokens,
    input: `Page ${page}. The page as run 1 wrote it, per block:\n\n${blockList(blocks)}`,
    images: [await pageImageUrl(ctx.jobId, image)],
    schemaName: 'style_patches',
    schema
  });

  return (result.patches ?? [])
    .map((p) => ({
      op: 'style' as const,
      target: p.target ?? '',
      find: (p.find ?? '').trim(),
      style: (p.style ?? []).filter((s): s is InlineStyle => ALLOWED.includes(s as InlineStyle))
    }))
    .filter((p) => p.find.length > 1 && p.style.length > 0);
}
