import { sleep } from '../util';

/**
 * Mistral answers every call, refused or not, with how many requests this key may
 * make per minute and how many of those are left. A client that reads those
 * headers can keep to the limit instead of finding it by being turned away, and
 * the limit is whatever is set on admin.mistral.ai/plateforme/limits - so it is
 * read off the answers rather than written down here.
 *
 * One bucket per endpoint and model, because that is how the limits are set, and
 * one queue per bucket shared by every call in the process: the pages of a run go
 * out side by side, and without a queue four of them would spend one minute's
 * allowance in the same instant.
 */
interface Bucket {
  /** Requests per minute as Mistral last reported it; null until it has said. */
  limit: number | null;
  remaining: number | null;
  /** The earliest moment the next request may leave. */
  next: number;
  /** When a used-up minute is over. */
  windowEnd: number;
  chain: Promise<void>;
}

const buckets = new Map<string, Bucket>();

function bucket(key: string): Bucket {
  let b = buckets.get(key);
  if (!b) {
    b = { limit: null, remaining: null, next: 0, windowEnd: 0, chain: Promise.resolve() };
    buckets.set(key, b);
  }
  return b;
}

/** Take in what Mistral said about the limit on this answer. */
export function observe(key: string, headers: Headers): void {
  const b = bucket(key);
  const limit = headers.get('x-ratelimit-limit-req-minute');
  const remaining = headers.get('x-ratelimit-remaining-req-minute');
  if (limit !== null && Number.isFinite(Number(limit))) b.limit = Number(limit);
  if (remaining !== null && Number.isFinite(Number(remaining))) {
    b.remaining = Number(remaining);
    if (b.remaining <= 0 && b.limit) b.windowEnd = Date.now() + 60_000;
  }
}

/**
 * A limit of zero is not a busy minute that will pass: the key is not allowed to
 * call this model at all, and waiting only makes the failure slower.
 */
export function closed(key: string): boolean {
  return bucket(key).limit === 0;
}

export function limitOf(key: string): number | null {
  return bucket(key).limit;
}

/**
 * Wait for this call's turn. Calls are spaced evenly over the minute rather than
 * sent in a burst and then held, which keeps a streamed page from stalling
 * halfway behind the others.
 */
export function slot(key: string, fallbackPerMinute: number): Promise<void> {
  const b = bucket(key);
  const turn = b.chain.then(async () => {
    const perMinute = b.limit && b.limit > 0 ? b.limit : fallbackPerMinute;
    const gap = 60_000 / Math.max(1, perMinute);
    const now = Date.now();
    const wait = Math.max(b.next - now, b.remaining === 0 ? b.windowEnd - now : 0, 0);
    if (wait > 0) await sleep(wait);
    if (b.remaining === 0) b.remaining = null;
    b.next = Date.now() + gap;
  });
  b.chain = turn.catch(() => undefined);
  return turn;
}
