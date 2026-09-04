import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export interface RunPrompt {
  titel: string;
  wanneer: string;
  krijgt: string;
  levert: string;
  instructions: string;
  effort: string | null;
  maxOutputTokens: number | null;
}

export interface PromptFile {
  rules: string;
  runs: Record<string, RunPrompt>;
}

export interface ResolvedPrompt {
  instructions: string;
  effort?: string;
  maxOutputTokens?: number;
}

let cache: PromptFile | null = null;
let cachedAt = 0;

/**
 * The prompts live in prompts.json so they can be tuned without touching code.
 * The file is re-read whenever it changes; a broken edit keeps the last good
 * version in use rather than taking the run down halfway.
 */
function load(): PromptFile {
  const file = resolve(process.cwd(), 'prompts.json');
  try {
    const mtime = statSync(file).mtimeMs;
    if (!cache || mtime !== cachedAt) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as PromptFile;
      if (typeof parsed.rules !== 'string' || !parsed.runs) {
        throw new Error('"rules" of "runs" ontbreekt');
      }
      cache = parsed;
      cachedAt = mtime;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!cache) throw new Error(`prompts.json kon niet worden gelezen: ${message}`);
    console.warn(`[prompts] prompts.json is ongeldig (${message}); de vorige versie blijft in gebruik`);
  }
  return cache as PromptFile;
}

export function promptFor(run: string): ResolvedPrompt {
  const file = load();
  const entry = file.runs[run];
  if (!entry) throw new Error(`prompts.json mist de run "${run}"`);
  if (typeof entry.instructions !== 'string' || !entry.instructions.trim()) {
    throw new Error(`prompts.json: run "${run}" heeft geen instructions`);
  }
  return {
    instructions: `${file.rules}\n\n${entry.instructions}`,
    effort: entry.effort ?? undefined,
    maxOutputTokens: entry.maxOutputTokens ?? undefined
  };
}

export function allPrompts(): PromptFile {
  return load();
}
