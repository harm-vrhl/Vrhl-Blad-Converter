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
