import { cleanupText } from './cleanup';
import { tokens } from './util';
import type { IndexCheck, WordIndex } from './types';

/** Mistral's words, normalised and counted. The page's vocabulary, nothing more. */
export function buildIndex(page: number, text: string): WordIndex {
  // The OCR still carries line-break hyphens; the written-out page does not.
  // Count both readings and keep the higher one, so a repaired word is not
  // mistaken for an invented one.
  const raw = count(tokens(text));
  const joined = count(tokens(cleanupText(text)));
  const counts: Record<string, number> = { ...raw };
  for (const [word, n] of Object.entries(joined)) counts[word] = Math.max(counts[word] ?? 0, n);
  return { page, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
}

function count(words: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const word of words) out[word] = (out[word] ?? 0) + 1;
  return out;
}

/**
 * Check what a run wrote against what the page actually holds.
 * A word that is not in the index at all is a hallucination; a word used more
 * often than it occurs points at duplicated text, that is where it went wrong.
 */
export function checkAgainstIndex(index: WordIndex, output: string): IndexCheck {
  const used: Record<string, number> = {};
  for (const word of tokens(output)) used[word] = (used[word] ?? 0) + 1;

  const unknown: string[] = [];
  const overused: IndexCheck['overused'] = [];
  let backed = 0;
  let total = 0;

  for (const [word, count] of Object.entries(used)) {
    const available = index.counts[word] ?? 0;
    total += count;
    backed += Math.min(count, available);
    if (available === 0) {
      if (word.length > 2) unknown.push(word);
    } else if (count > available) {
      overused.push({ word, used: count, available });
    }
  }

  return {
    unknown: unknown.slice(0, 40),
    overused: overused.sort((a, b) => b.used - a.used).slice(0, 20),
    score: total ? backed / total : 1
  };
}
