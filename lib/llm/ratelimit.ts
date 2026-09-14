import { sleep } from '../util';

/**
 * Mistral answers every call with how many requests this key may make per minute.
 * A limit of 0 means the key may not use the model at all. The start rate itself
 * is not taken from those headers: Medium 3.5 is one request per second, set as
 * MISTRAL_REQ_PER_MINUTE=60, and pacing faster than that is how a run hits 429s
 * and then waits. Remaining-in-window is ignored for the same reason; on a 1/s
 * key it can read 0 after every call.
 *
 * One bucket per endpoint and model, and one queue per bucket shared by every
 * call in the process: the pages of a run go out side by side.
 */
interface Bucket {
  /** Requests per minute as Mistral last reported it; null until it has said. */
  limit: number | null;
  /** The earliest moment the next request may leave. */
  next: number;
  chain: Promise<void>;
}

const buckets = new Map<string, Bucket>();

function bucket(key: string): Bucket {
  let b = buckets.get(key);
  if (!b) {
    b = { limit: null, next: 0, chain: Promise.resolve() };
    buckets.set(key, b);
  }
  return b;
}

/** Take in what Mistral said about the limit on this answer. */
export function observe(key: string, headers: Headers): void {
  const b = bucket(key);
  const limit = headers.get('x-ratelimit-limit-req-minute');
  if (limit !== null && Number.isFinite(Number(limit))) b.limit = Number(limit);
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
 * Wait for this call's turn. Starts are spaced evenly at `perMinute` (60 is one
 * per second) and never faster. Exhaustion is a 429; withRetries honours Retry-After.
 */
export function slot(key: string, perMinute: number): Promise<void> {
  const b = bucket(key);
  const turn = b.chain.then(async () => {
    const gap = 60_000 / Math.max(1, perMinute);
    const wait = Math.max(b.next - Date.now(), 0);
    if (wait > 0) await sleep(wait);
    b.next = Date.now() + gap;
  });
  b.chain = turn.catch(() => undefined);
  return turn;
}
