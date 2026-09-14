/** Bounded-parallel map. Keeps result order, runs `limit` tasks at a time. */
export async function pMap<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Lowercase word tokens, accents kept, used for coverage/hallucination checks. */
export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) as string[];
}

export function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function uniq<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function clamp01(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Reject when a step takes too long; the message names what was waited for. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} duurde te lang (${Math.round(ms / 1000)} s)`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** A queue that lets a generator yield events while background work is still running. */
export class EventQueue<T> {
  private items: T[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;

  push(item: T): void {
    this.items.push(item);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  async *drain(): AsyncGenerator<T, void, void> {
    for (;;) {
      while (this.items.length) yield this.items.shift() as T;
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

/**
 * What can already be read from JSON that is still arriving.
 *
 * A structured run answers with one object, so until the last brace lands there
 * is nothing to parse - and a run that spends twenty seconds on an opening
 * spread leaves the reader looking at nothing for twenty seconds. This reads the
 * half of it that is finished: everything up to the last completed field is kept,
 * whatever was mid-word is dropped, and the open brackets are closed so the rest
 * parses.
 *
 * It is deliberately conservative. A field it is not sure about is a field the
 * caller does not get yet, because showing half a title and then changing it is
 * worse than showing it a moment later.
 */
export function partialJson<T>(text: string): T | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  const body = text.slice(start);

  // Whole and valid already: nothing to repair.
  try {
    return JSON.parse(body) as T;
  } catch {
    /* still arriving */
  }

  const cut = lastComplete(body);
  if (cut <= 0) return null;
  const closed = closeOpen(body.slice(0, cut));
  try {
    return JSON.parse(closed) as T;
  } catch {
    return null;
  }
}

/** Where the last finished field or element ends, ignoring anything after it. */
function lastComplete(src: string): number {
  let inString = false;
  let escaped = false;
  let depth = 0;
  let cut = -1;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      cut = i + 1;
    } else if (ch === ',' && depth > 0) cut = i;
  }
  return cut;
}

/** The same text with every bracket it left open closed again. */
function closeOpen(src: string): string {
  let text = src.replace(/[\s,]+$/, '');
  let inString = false;
  let escaped = false;
  const open: string[] = [];

  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') open.push('}');
    else if (ch === '[') open.push(']');
    else if (ch === '}' || ch === ']') open.pop();
  }
  if (inString) text += '"';
  return text + open.reverse().join('');
}
